import { z } from "zod";
import { ACTIVITY_STATUSES, type ActivityStatus, type HqStatus, type NeedsReviewKey } from "./enums";
import { bcDateSchema, idSchema, safeString } from "./input";

/** The list's "Display" choice (spec addendum §8.1; legacy FilterDisplayValue 3, 2, 4 and 10). */
export const LIST_DISPLAYS = ["all", "my_ministries", "my_activities", "my_watchlist"] as const;
export type ListDisplay = (typeof LIST_DISPLAYS)[number];

/** The list's columns in legacy's order (UCFlexiGrid.ascx.cs:255-274). */
export const LIST_COLUMNS = [
  "activity", "keywords", "ministry", "status", "dateTime", "title", "categories", "commMaterials", "premier", "leadOrg", "translations", "city", "commContact", "governmentRep",
] as const;
export type ListColumn = (typeof LIST_COLUMNS)[number];
export const LIST_COLUMN_LABELS: Readonly<Record<ListColumn, string>> = {
  activity: "Activity Id", keywords: "HQ Tags", ministry: "Ministry", status: "Status", dateTime: "Date & Time", title: "Title & Summary",
  categories: "Categories", commMaterials: "Comm. Materials", premier: "Premier", leadOrg: "Lead Org.", translations: "Translations", city: "City",
  commContact: "Comm. Contact", governmentRep: "Govt Rep.",
};
/** The Activity Id cell holds the row's checkbox and watch star, so it always shows. */
export type HideableColumn = Exclude<ListColumn, "activity">;
export const HIDEABLE_COLUMNS = LIST_COLUMNS.filter((c): c is HideableColumn => c !== "activity");
/** Legacy's ColumnModel.HiddenByDefault: HQ Tags, Ministry, Status and Translations. */
export const DEFAULT_HIDDEN_COLUMNS: readonly HideableColumn[] = ["keywords", "ministry", "status", "translations"];

/** Every column legacy could sort by; Premier couldn't. */
export const LIST_SORTS = [
  "activity", "keywords", "ministry", "status", "dateTime", "title", "categories", "commMaterials", "leadOrg", "translations", "city", "commContact", "governmentRep",
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** The Admin Settings' Look Ahead filter (Default.aspx:684-698): HQ Advanced and above. */
export const LOOK_AHEAD_FILTERS = ["all", "look_ahead_only", "not_for_look_ahead_only"] as const;
export type LookAheadFilter = (typeof LOOK_AHEAD_FILTERS)[number];

/** Corporate Queries' statuses (Default.aspx:628-660, Default.aspx.cs:44-49). */
export const CORPORATE_STATUSES = ["new", "changed", "reviewed", "deleted", "la_new", "la_changed"] as const;
export type CorporateStatus = (typeof CORPORATE_STATUSES)[number];

/** Rows per page, as legacy's grid (UCFlexiGrid.ascx.cs RecordsPerPage). */
export const LIST_PAGE_SIZE = 30;
/** The longest `q` parameter the list routes accept. */
export const LIST_QUERY_MAX_CHARS = 8000;
/** A month view's six weeks. */
export const CALENDAR_RANGE_MAX_DAYS = 42;

const unique = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;
const optionalId = idSchema.nullable().default(null);

/** What a saved filter holds (spec addendum §8.1). Display, the Look Ahead filter and the sort sit beside it in ListQuery. */
export const listFilterSchema = z
  .object({
    from: bcDateSchema.nullable().default(null),
    to: bcDateSchema.nullable().default(null),
    thisDayOnly: z.boolean().default(false),
    quickSearch: safeString().max(200).default("").transform((s) => s.trim()),
    /** HQ Tags, matched with OR. */
    keywordIds: z.array(idSchema).max(50).default([]),
    isIssue: z.boolean().nullable().default(null),
    dateConfirmed: z.boolean().nullable().default(null),
    status: z.enum(ACTIVITY_STATUSES).nullable().default(null),
    categoryId: optionalId,
    /** Lead Ministry: a Core organization key, byte for byte. */
    ministryKey: safeString().min(1).max(200).nullable().default(null),
    /** Comm Contact: the person (a Core user id), whichever of their comm contact rows the activity holds. */
    commContactUserId: z.string().uuid().transform((s) => s.toLowerCase()).nullable().default(null),
    representativeId: optionalId,
    initiativeId: optionalId,
    premierRequestedId: optionalId,
    distributionId: optionalId,
  })
  .strict()
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "From must be on or before To", path: ["to"] });
export type ListFilter = z.output<typeof listFilterSchema>;
export const EMPTY_LIST_FILTER: ListFilter = listFilterSchema.parse({});

export const corporateQuerySchema = z
  .object({
    /** Null is "Show all" upcoming; otherwise the next N days. */
    days: z.number().int().min(0).max(366).nullable(),
    statuses: z.array(z.enum(CORPORATE_STATUSES)).min(1).max(CORPORATE_STATUSES.length).refine(unique, "each status once"),
  })
  .strict();
export type CorporateQuery = z.output<typeof corporateQuerySchema>;

export const listQuerySchema = z
  .object({
    filter: listFilterSchema.default({}),
    /** A corporate query replaces the filter and the display. */
    corporate: corporateQuerySchema.nullable().default(null),
    display: z.enum(LIST_DISPLAYS).default("all"),
    lookAhead: z.enum(LOOK_AHEAD_FILTERS).default("all"),
    sort: z.enum(LIST_SORTS).default("dateTime"),
    dir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export type ListQuery = z.output<typeof listQuerySchema>;
export type ListQueryInput = z.input<typeof listQuerySchema>;
export const DEFAULT_LIST_QUERY: ListQuery = listQuerySchema.parse({});

export const listPreferencesSchema = z
  .object({
    display: z.enum(LIST_DISPLAYS),
    hiddenColumns: z.array(z.enum(HIDEABLE_COLUMNS as [HideableColumn, ...HideableColumn[]])).max(HIDEABLE_COLUMNS.length).refine(unique, "each column once"),
  })
  .strict();
export type ListPreferences = z.output<typeof listPreferencesSchema>;

const savedFilterName = safeString().trim().min(1, "Enter a name").max(200, "At most 200 characters");
export const savedFilterCreateSchema = z.object({ name: savedFilterName, filter: listFilterSchema }).strict();
export const savedFilterRenameSchema = z.object({ name: savedFilterName }).strict();
export const savedFilterOrderSchema = z.object({ ids: z.array(idSchema).max(200).refine(unique, "each query once") }).strict();

/** Why a calendar range is refused, or null. */
export function checkCalendarRange(start: string, end: string): string | null {
  if (end < start) return "The range must end on or after it starts";
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  return days > CALENDAR_RANGE_MAX_DAYS ? `A calendar range is at most ${CALENDAR_RANGE_MAX_DAYS} days` : null;
}

/** One row of the list (UCFlexiGrid's columns, plus what the Excel export and the tooltips need). */
export interface ListRow {
  id: number;
  version: number;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  status: ActivityStatus;
  hqStatus: HqStatus | null;
  isDeleted: boolean;
  isWatched: boolean;
  /** The star's tooltip (Activity.aspx.cs:1519-1535). */
  watcherNames: string[];
  isShared: boolean;
  hasRelease: boolean;
  createdAt: string;
  lastUpdatedAt: string;
  lastUpdatedByName: string | null;
  /** HQ Tags. */
  keywords: string[];
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates: string;
  title: string;
  details: string;
  significance: string;
  strategy: string;
  schedule: string;
  categories: string[];
  isIssue: boolean;
  isConfidential: boolean;
  commMaterials: string[];
  nrOrigins: string[];
  nrDistribution: string | null;
  premierRequested: string | null;
  leadOrganization: string;
  translations: string[];
  /** The city's name, or Other City when the city is "Other…". */
  city: string | null;
  venue: string;
  commContact: { name: string; phone: string | null } | null;
  governmentRepresentative: string | null;
  eventPlanner: string | null;
  /** The list's review markup: empty unless the viewer is HQ at Administrator and above (spec addendum §6). */
  needsReview: NeedsReviewKey[];
}

export interface ListPage {
  rows: ListRow[];
  total: number;
  offset: number;
}

export interface ListOption {
  id: number;
  name: string;
}

/** The filter panel's choices (Default.aspx.cs:55-140). */
export interface ListOptions {
  categories: ListOption[];
  keywords: ListOption[];
  representatives: ListOption[];
  initiatives: ListOption[];
  premierRequested: ListOption[];
  distributions: ListOption[];
  ministries: { key: string; abbreviation: string | null; name: string }[];
  commContacts: { userId: string; name: string }[];
}

export interface SavedFilterView {
  id: number;
  name: string;
  sortOrder: number;
  /** Null when what is stored no longer reads as a filter. */
  filter: ListFilter | null;
}

export interface CalendarItem {
  id: number;
  title: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  isConfidential: boolean;
  ministryAbbreviation: string | null;
}

export interface CalendarRangeView {
  items: CalendarItem[];
  truncated: boolean;
}
