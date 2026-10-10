import { z } from "zod";
import { HQ_SECTIONS, HQ_STATUSES } from "./enums";

/** The database's int4 bound: a larger id would overflow its column instead of failing validation. */
export const idSchema = z.number().int().positive().max(2_147_483_647);
const id = idSchema;
/** Every string the API takes: Postgres text can't hold a NUL character. */
export const safeString = () => z.string().regex(/^[^\u0000]*$/, "no NUL characters");
/** A year outside these is a typo; years like 0001 or 9999 otherwise reach the database as timestamps it refuses. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2199;
const realDate = (s: string) => {
  const year = Number(s.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
/** A BC calendar date, YYYY-MM-DD, between 1900 and 2199. */
export const bcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(realDate, `not a real date between ${MIN_YEAR} and ${MAX_YEAR}`);
const date = bcDateSchema;
/** A BC wall-clock time, 24-hour. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour");
// These caps only bound the request. The editor's own limits are checkActivity's, on changed values.
const text = safeString().max(10_000);
const key = safeString().min(1).max(200);
const keys = z.array(key).max(200);
const ids = z.array(id).max(200);

export const lookAheadFieldsSchema = z
  .object({ hqComments: text, hqStatus: z.enum(HQ_STATUSES).nullable(), hqSection: z.enum(HQ_SECTIONS), longTermOutlook: z.boolean() })
  .strict();
export type LookAheadFields = z.infer<typeof lookAheadFieldsSchema>;

/**
 * Everything the editor saves (spec addendum §8.2). Status, needs-review flags, versions and
 * bookkeeping are the server's: strict, so a body that sets them is refused.
 */
export const activityFieldsSchema = z
  .object({
    /** The editor's single category; an imported activity can hold two, kept while this is unchanged. */
    categoryId: id.nullable(),
    title: text,
    details: text,
    significance: text,
    strategy: text,
    schedule: text,
    comments: text,
    leadOrganization: text,
    venue: text,
    otherCity: text,
    potentialDates: text,
    isIssue: z.boolean(),
    isConfidential: z.boolean(),
    isMilestone: z.boolean(),
    isCrossGovernment: z.boolean(),
    isAtLegislature: z.boolean(),
    isAllDay: z.boolean(),
    isConfirmed: z.boolean(),
    startDate: date.nullable(),
    startTime: time.nullable(),
    endDate: date.nullable(),
    endTime: time.nullable(),
    nrDate: date.nullable(),
    nrTime: time.nullable(),
    contactMinistryKey: key.nullable(),
    commContactId: id.nullable(),
    governmentRepresentativeId: id.nullable(),
    cityId: id.nullable(),
    premierRequestedId: id.nullable(),
    nrDistributionId: id.nullable(),
    eventPlannerId: id.nullable(),
    videographerId: id.nullable(),
    /** Single-select in the editor; an imported activity's several origins are kept while this is unchanged. */
    nrOriginId: id.nullable(),
    commMaterialIds: ids,
    initiativeIds: ids,
    /** HQ Tags, by name: a new name creates the keyword (C146). */
    keywordNames: z.array(safeString().max(1000)).max(200),
    sectorKeys: keys,
    themeKeys: keys,
    /** News Subscribe. */
    tagKeys: keys,
    sharedWithKeys: keys,
    translations: z.array(safeString().max(1000)).max(200),
    /** Only from users who see the Look Ahead fieldset (spec addendum §6). */
    lookAhead: lookAheadFieldsSchema.optional(),
  })
  .strict();
export type ActivityFields = z.infer<typeof activityFieldsSchema>;

export const createActivitySchema = activityFieldsSchema;
export const updateActivitySchema = activityFieldsSchema.extend({ version: z.number().int().positive(), tabId: safeString().min(1).max(100).nullable() }).strict();
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
