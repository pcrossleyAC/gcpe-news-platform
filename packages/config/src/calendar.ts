import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour");
const id = z.number().int().positive();
const names = z.array(z.string().min(1));

/**
 * The tenant's Corporate Calendar settings (spec addendum §5.1). BC's values come from legacy and
 * live in config/tenants/bc.json, so no legacy id or category name is written into a rule. The
 * freeze is evaluated in the tenant's own timeZone.
 */
export const calendarTenantSchema = z
  .object({
    freeze: z.object({ start: hhmm, end: hhmm }).strict(),
    releaseCategoryIds: z.array(id),
    awarenessCategoryIds: z.array(id),
    otherCityId: id,
    unconfirmedIssueCommMaterialId: id,
    hqPlaceholderCategoryName: z.string().min(1),
    confidentialCategoryName: z.string().min(1),
    issueExemptCategoryNames: names,
    eventsCategoryNames: names,
    consultationsMinistryAbbreviation: z.string().min(1),
    contactMinistryExcludedAbbreviations: names,
    sharedWithExcludedAbbreviations: names,
    translationsDefault: names,
    required: z.object({ significance: z.boolean(), scheduling: z.boolean(), strategy: z.boolean() }).strict(),
    showHqCommentsField: z.boolean(),
    showRecordsSection: z.boolean(),
    cloneKeptKeywordNames: names,
    lookAheadCoverImage: z.string().min(1).nullable(),
    reportBanner: z.object({ province: z.string().min(1), confidentiality: z.string().min(1) }).strict(),
  })
  .strict();

export type CalendarTenantConfig = z.infer<typeof calendarTenantSchema>;
