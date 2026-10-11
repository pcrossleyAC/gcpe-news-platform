/** Legacy calendar.* rows as the importer reads them (Gcpe.Hub.Database/calendar/Tables). DATETIME
 * values arrive as Dates whose UTC fields hold the BC wall-clock time. */
export interface LegacyActivity extends Record<string, unknown> {
  Id: number;
  StartDateTime: Date | null; EndDateTime: Date | null; NRDateTime: Date | null;
  PotentialDates: string | null;
  Title: string; Details: string; Schedule: string; Significance: string;
  Strategy: string | null; Comments: string | null; HqComments: string | null;
  LeadOrganization: string | null; Venue: string | null; OtherCity: string | null; Translations: string | null;
  StatusId: number | null; HqStatusId: number | null; HqSection: number;
  NRDistributionId: number | null; PremierRequestedId: number | null; ContactMinistryId: string | null;
  GovernmentRepresentativeId: number | null; CommunicationContactId: number | null;
  EventPlannerId: number | null; VideographerId: number | null; CityId: number | null;
  IsActive: boolean; IsConfirmed: boolean; IsIssue: boolean; IsAllDay: boolean; IsAtLegislature: boolean;
  IsConfidential: boolean; IsCrossGovernment: boolean; IsMilestone: boolean;
  IsTitleNeedsReview: boolean; IsDetailsNeedsReview: boolean; IsRepresentativeNeedsReview: boolean;
  IsCityNeedsReview: boolean; IsStartDateNeedsReview: boolean; IsEndDateNeedsReview: boolean;
  IsCategoriesNeedsReview: boolean; IsCommMaterialsNeedsReview: boolean; IsActiveNeedsReview: boolean;
  IsSignificanceNeedsReview: boolean; IsStrategyNeedsReview: boolean; IsSchedulingConsiderationsNeedsReview: boolean;
  IsInternalNotesNeedsReview: boolean; IsLeadOrganizationNeedsReview: boolean; IsInitiativesNeedsReview: boolean;
  IsTagsNeedsReview: boolean; IsOriginNeedsReview: boolean; IsDistributionNeedsReview: boolean;
  IsTranslationsRequiredNeedsReview: boolean; IsPremierRequestedNeedsReview: boolean; IsVenueNeedsReview: boolean;
  IsEventPlannerNeedsReview: boolean; IsDigitalNeedsReview: boolean;
  CreatedDateTime: Date | null; CreatedBy: number | null; LastUpdatedDateTime: Date | null; LastUpdatedBy: number | null;
}
/** Every activity join table, read as (ActivityId, ValueId): an int lookup id or a GUID. */
export interface LegacyJoinRow extends Record<string, unknown> { ActivityId: number; ValueId: number | string; IsActive: boolean }
export const JOIN_TABLES = ["categories", "commMaterials", "initiatives", "keywords", "nrOrigins", "sectors", "themes", "tags", "sharedWith"] as const;
export type JoinTable = (typeof JOIN_TABLES)[number];
export interface LegacyUser extends Record<string, unknown> {
  Id: number; RoleId: number; DisplayName: string | null; FullName: string | null; EmailAddress: string | null;
  IsActive: boolean; JobTitle: string | null; PhoneNumber: string | null; MobileNumber: string | null; Description: string | null;
  FilterDisplayValue: number | null; HiddenColumns: string | null; LastUpdatedDateTime: Date | null;
}
export interface LegacyUserMinistry extends Record<string, unknown> { SystemUserId: number; MinistryId: string; IsActive: boolean }
export interface LegacyCommContact extends Record<string, unknown> { Id: number; SystemUserId: number; MinistryId: string | null; SortOrder: number | null; IsActive: boolean | null }
export interface LegacySavedFilter extends Record<string, unknown> { Id: number; CreatedBy: number | null; Name: string | null; QueryString: string | null; SortOrder: number | null; IsActive: boolean | null }
export interface LegacyFavourite extends Record<string, unknown> { SystemUserId: number; ActivityId: number }
export interface LegacyFile extends Record<string, unknown> { Id: number; ActivityId: number; Data: Buffer; FileName: string; FileType: string; FileLength: number; Md5: string; LastUpdatedDateTime: Date; LastUpdatedBy: number | null }
export interface LegacyLog extends Record<string, unknown> { Id: number; ActivityId: number; FieldName: string | null; OldValue: string | null; NewValue: string | null; Operation: string; CreatedDateTime: Date | null; CreatedBy: number | null; LastUpdatedDateTime: Date }
export interface LegacyLookup extends Record<string, unknown> { Id: number; Name: string | null; SortOrder: number | null; IsActive: boolean | null; PhoneNumber?: string | null; JobTitle?: string | null; Description?: string | null; ShortName?: string | null }
export interface LegacyReleaseLink extends Record<string, unknown> { ActivityId: number; N: number }
export const LOOKUP_TABLES = ["categories", "cities", "commMaterials", "eventPlanners", "governmentRepresentatives", "initiatives", "keywords", "nrDistributions", "nrOrigins", "premierRequested", "videographers"] as const;
export type LookupTable = (typeof LOOKUP_TABLES)[number];

export interface LegacySnapshot {
  activities: LegacyActivity[];
  joins: Record<JoinTable, LegacyJoinRow[]>;
  users: LegacyUser[];
  userMinistries: LegacyUserMinistry[];
  commContacts: LegacyCommContact[];
  savedFilters: LegacySavedFilter[];
  favourites: LegacyFavourite[];
  files: LegacyFile[];
  logs: LegacyLog[];
  lookups: Record<LookupTable, LegacyLookup[]>;
  releaseLinks: LegacyReleaseLink[];
  /** Whole-table counts, so rows SQL already left out are still counted as out of scope. */
  totals: { activities: number; favourites: number; files: number; logs: number };
}
