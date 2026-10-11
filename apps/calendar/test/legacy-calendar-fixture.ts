import { createHash } from "node:crypto";
import type { Db } from "@gcpe/db-kit";
import { upsertOrganization } from "../../core/src/services/organizations";
import { upsertTerm } from "../../core/src/services/terms";
import { createUser } from "../../core/src/services/users";
import { healthOrg } from "../../core/test/helpers";
import type { LegacyActivity } from "../src/import/legacy-rows";

/** A fictional cutoff, used by tests only: the real one is Q53's, passed with --cutoff. */
export const TEST_CUTOFF = "2027-01-15";
/** Fictional legacy GUIDs, uppercase as legacy stores them. */
export const GUID = {
  fin: "0F000000-0000-4000-8000-000000000001",
  hlth: "0F000000-0000-4000-8000-000000000002",
  hq: "0F000000-0000-4000-8000-000000000003",
  sector: "0F000000-0000-4000-8000-000000000004",
  theme: "0F000000-0000-4000-8000-000000000005",
  tag: "0F000000-0000-4000-8000-000000000006",
  unknown: "0F000000-0000-4000-8000-0000000000FF",
} as const;
/** Appears only in the confidential activity's title: the report must never contain it. */
export const CONFIDENTIAL_MARKER = "Sample confidential subject";
const wall = (iso: string) => new Date(`${iso}Z`);
export const PDF_BYTES = Buffer.from("%PDF-1.4\n% sample\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex").toUpperCase();

function activity(Id: number, over: Partial<LegacyActivity>): LegacyActivity {
  return {
    Id, StartDateTime: null, EndDateTime: null, NRDateTime: null, PotentialDates: null,
    Title: `Sample activity ${Id}`, Details: "Sample details", Schedule: "", Significance: "Sample significance",
    Strategy: null, Comments: null, HqComments: null, LeadOrganization: null, Venue: null, OtherCity: null, Translations: null,
    StatusId: 2, HqStatusId: null, HqSection: 2, NRDistributionId: null, PremierRequestedId: null, ContactMinistryId: GUID.fin,
    GovernmentRepresentativeId: null, CommunicationContactId: 501, EventPlannerId: null, VideographerId: null, CityId: 5,
    IsActive: true, IsConfirmed: false, IsIssue: false, IsAllDay: false, IsAtLegislature: false, IsConfidential: false,
    IsCrossGovernment: false, IsMilestone: false,
    IsTitleNeedsReview: false, IsDetailsNeedsReview: false, IsRepresentativeNeedsReview: false, IsCityNeedsReview: false,
    IsStartDateNeedsReview: false, IsEndDateNeedsReview: false, IsCategoriesNeedsReview: false, IsCommMaterialsNeedsReview: false,
    IsActiveNeedsReview: false, IsSignificanceNeedsReview: false, IsStrategyNeedsReview: false, IsSchedulingConsiderationsNeedsReview: false,
    IsInternalNotesNeedsReview: false, IsLeadOrganizationNeedsReview: false, IsInitiativesNeedsReview: false, IsTagsNeedsReview: false,
    IsOriginNeedsReview: false, IsDistributionNeedsReview: false, IsTranslationsRequiredNeedsReview: false, IsPremierRequestedNeedsReview: false,
    IsVenueNeedsReview: false, IsEventPlannerNeedsReview: false, IsDigitalNeedsReview: false,
    CreatedDateTime: wall("2026-09-01T10:00:00"), CreatedBy: 11, LastUpdatedDateTime: wall("2026-09-02T10:00:00"), LastUpdatedBy: 11,
    ...over,
  };
}
const lk = (Id: number, Name: string | null, IsActive: boolean | null = true, extra: object = {}) => ({ Id, Name, SortOrder: Id, IsActive, ...extra });
const user = (Id: number, EmailAddress: string | null, IsActive: boolean, RoleId: number, over: object = {}) => ({
  Id, RoleId, DisplayName: `Sample User ${Id}`, FullName: null, EmailAddress, IsActive, JobTitle: null, PhoneNumber: null,
  MobileNumber: "", Description: null, FilterDisplayValue: null, HiddenColumns: null, LastUpdatedDateTime: wall("2026-01-01T00:00:00"), ...over,
});
const j = (ActivityId: number, ValueId: number | string, IsActive = true) => ({ ActivityId, ValueId, IsActive });
const log = (Id: number, ActivityId: number, FieldName: string | null, Operation: string, CreatedBy: number | null, at: string, OldValue: string | null = "a", NewValue: string | null = "b") =>
  ({ Id, ActivityId, FieldName, OldValue, NewValue, Operation, CreatedDateTime: wall(at), CreatedBy, LastUpdatedDateTime: wall(at) });

/** The synthetic legacy database, keyed by query name (queries.ts). */
export function legacyCalendarTables(): Record<string, Record<string, unknown>[]> {
  const activities = [
    activity(1001, { StartDateTime: wall("2027-01-20T09:00:00"), EndDateTime: wall("2027-01-20T10:00:00"), StatusId: 7, HqSection: 2, CityId: 311, OtherCity: "Sample Bay",
      Translations: "French, Punjabi ,,", IsTitleNeedsReview: true, IsDigitalNeedsReview: true, CreatedBy: 11, LastUpdatedBy: 12 }),
    activity(1002, { StartDateTime: wall("2027-01-14T09:00:00"), EndDateTime: wall("2027-01-15T00:00:00"), HqSection: 1 }), // ends exactly at the cutoff
    activity(1003, { StartDateTime: wall("2027-01-14T09:00:00"), EndDateTime: new Date(Date.UTC(2027, 0, 14, 23, 59, 59, 997)) }), // 3 ms before: out
    activity(1004, { StartDateTime: wall("2026-12-01T09:00:00"), EndDateTime: wall("2027-02-01T17:00:00"), HqSection: 3, CommunicationContactId: 504 }), // spans the cutoff
    activity(1005, { StartDateTime: wall("2027-01-16T09:00:00"), EndDateTime: wall("2027-01-16T10:00:00"), HqSection: 4, IsActive: false, LastUpdatedBy: 12 }), // deleted, post-cutoff
    activity(1006, { StartDateTime: wall("2019-05-01T00:00:00"), EndDateTime: wall("2019-05-01T23:45:00"), IsAllDay: true, HqSection: -1 }), // awareness, before the cutoff
    activity(1007, { StartDateTime: wall("2018-05-01T00:00:00"), EndDateTime: wall("2018-05-01T23:45:00"), IsAllDay: true, IsActive: false }), // awareness, deleted: out
    activity(1008, { StartDateTime: wall("2026-06-01T09:00:00"), EndDateTime: wall("2026-06-01T10:00:00"), CreatedBy: 15, LastUpdatedBy: 15 }), // before the cutoff; has a release, log, favourite, file
    activity(1009, { StartDateTime: wall("2027-03-01T09:00:00"), EndDateTime: null, HqSection: -2, CommunicationContactId: null, CreatedBy: 16, LastUpdatedBy: 16 }), // no end; no comm contact (C147)
    activity(1010, { StartDateTime: wall("2027-02-10T09:00:00"), EndDateTime: wall("2027-01-10T09:00:00"), HqSection: -3 }), // ends before it starts
    activity(1011, { StartDateTime: wall("2027-01-18T09:00:00"), EndDateTime: wall("2027-01-18T10:00:00"), HqSection: -4, IsConfidential: true, StatusId: 1, HqStatusId: 1,
      Title: `${CONFIDENTIAL_MARKER} ${"x".repeat(217 - CONFIDENTIAL_MARKER.length - 1)}` }), // confidential, shared with HLTH, 217-character title
    activity(1012, { StartDateTime: wall("2027-01-22T09:00:00"), EndDateTime: wall("2027-01-22T10:00:00"), StatusId: null, HqStatusId: 7, HqSection: 0, IsConfirmed: true,
      CreatedDateTime: null, Details: "Sample\u0000details" }), // nulls, HqSection 0, a NUL, the two-space category
    activity(1013, { StartDateTime: wall("2027-02-01T09:00:00"), EndDateTime: wall("2250-01-01T09:00:00") }), // year out of range: rejected
    activity(1014, {}), // no dates, not awareness: out
  ];
  return {
    activities: activities as (LegacyActivity & Record<string, unknown>)[],
    activityCount: [{ N: activities.length }],
    activityCategories: [j(1001, 12), j(1001, 58), j(1002, 12), j(1004, 12), j(1005, 12), j(1006, 2), j(1007, 2), j(1008, 58), j(1009, 12), j(1010, 12), j(1011, 12), j(1012, 16), j(1013, 12), j(1001, 12) /* duplicate */, j(1002, 58, false) /* inactive */],
    activityCommMaterials: [j(1001, 3), j(1012, 61)],
    activityInitiatives: [j(1001, 7)],
    activityKeywords: [j(1001, 40), j(1001, 41)],
    activityNrOrigins: [j(1001, 8)],
    activitySectors: [j(1001, GUID.sector)],
    activityThemes: [j(1001, GUID.theme)],
    activityTags: [j(1001, GUID.tag)],
    activitySharedWith: [j(1011, GUID.hlth)],
    users: [
      user(11, "avery.sample@example.test", true, 2), // matches an active Core user with an NRMS role
      user(12, "blake.sample@example.test", true, 5), // matches a role-less inactive placeholder
      user(13, "casey.shared@example.test", true, 3, { LastUpdatedDateTime: wall("2026-01-01T00:00:00") }), // shares an email with 14
      user(14, " CASEY.shared@example.test ", false, 4, { LastUpdatedDateTime: wall("2026-06-01T00:00:00") }),
      user(15, "drew.sample@example.test", false, 1), // inactive, referenced only by an out-of-scope activity: not imported
      user(16, null, false, 1), // no email, creator of 1009: imported inactive
      user(17, "ellis.sample@example.test", false, 1), // inactive, unreferenced: not imported
      user(18, "finley.sample@example.test", false, 1, { DisplayName: "Finley Sample" }), // only a log actor: not imported
      user(19, "gray.sample@example.test", false, 2, { FilterDisplayValue: 4, HiddenColumns: "1,3" }), // owns an active saved filter
      user(20, "harper.sample@example.test", false, 2), // has a favourite on 1004
      user(21, "indy.sample@example.test", false, 2, { MobileNumber: "250-555-01" }), // an active comm contact's user; bad mobile
      user(22, "not-an-address", true, 2), // invalid email: imported inactive with none
    ],
    userMinistries: [
      { SystemUserId: 11, MinistryId: GUID.fin, IsActive: true }, { SystemUserId: 12, MinistryId: GUID.hq, IsActive: true },
      { SystemUserId: 13, MinistryId: GUID.fin, IsActive: true }, { SystemUserId: 14, MinistryId: GUID.hlth, IsActive: true },
      { SystemUserId: 17, MinistryId: GUID.unknown, IsActive: true }, // an out-of-scope user's unknown GUID never stops the run
    ],
    commContacts: [
      { Id: 501, SystemUserId: 11, MinistryId: GUID.fin, SortOrder: 1, IsActive: true },
      { Id: 502, SystemUserId: 21, MinistryId: GUID.hlth, SortOrder: 4, IsActive: true },
      { Id: 503, SystemUserId: 13, MinistryId: GUID.fin, SortOrder: 2, IsActive: true },
      { Id: 504, SystemUserId: 14, MinistryId: GUID.fin, SortOrder: 3, IsActive: false }, // same person and ministry as 503: merged
      { Id: 505, SystemUserId: 17, MinistryId: GUID.fin, SortOrder: 6, IsActive: false }, // inactive, unreferenced: out
      { Id: 506, SystemUserId: 12, MinistryId: null, SortOrder: 0, IsActive: true }, // no ministry: skipped
    ],
    savedFilters: [
      { Id: 701, CreatedBy: 11, Name: "Sample filter", QueryString: "Ministries=Sample&Status=7", SortOrder: 1, IsActive: true },
      { Id: 702, CreatedBy: 19, Name: "Sample stale filter", QueryString: "ActivityListProvider.aspx?Status=1&QuickSearch=sample%20typed%20text", SortOrder: 2, IsActive: true },
      { Id: 703, CreatedBy: 17, Name: "Sample old filter", QueryString: "Status=2", SortOrder: 3, IsActive: false },
    ],
    favourites: [{ SystemUserId: 11, ActivityId: 1001 }, { SystemUserId: 20, ActivityId: 1004 }, { SystemUserId: 15, ActivityId: 1008 }],
    favouriteCount: [{ N: 3 }],
    files: [
      { Id: 801, ActivityId: 1001, Data: PDF_BYTES, FileName: "C:\\fakepath\\briefing.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: md5(PDF_BYTES), LastUpdatedDateTime: wall("2026-09-03T10:00:00"), LastUpdatedBy: 11 },
      { Id: 802, ActivityId: 1001, Data: PDF_BYTES, FileName: "tampered.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: "0".repeat(32), LastUpdatedDateTime: wall("2026-09-03T10:00:00"), LastUpdatedBy: 11 },
      { Id: 803, ActivityId: 1008, Data: PDF_BYTES, FileName: "old.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: md5(PDF_BYTES), LastUpdatedDateTime: wall("2026-05-03T10:00:00"), LastUpdatedBy: 15 },
      { Id: 804, ActivityId: 1011, Data: Buffer.from("MZsample"), FileName: "notes.exe", FileType: "application/x-msdownload", FileLength: 8, Md5: md5(Buffer.from("MZsample")), LastUpdatedDateTime: wall("2026-09-04T10:00:00"), LastUpdatedBy: 11 },
    ],
    fileCount: [{ N: 4 }],
    logs: [
      log(9001, 1001, "Title", "Update", 11, "2026-09-05T10:00:00.100", "Old sample title", "Sample activity 1001"),
      log(9002, 1001, "CityId", "Update", 11, "2026-09-05T10:00:00.500", "5", "311"), // same activity, actor and second as 9001
      log(9003, 1001, null, "Edit", 11, "2026-09-05T09:59:00"), // lock noise
      log(9004, 1001, "PriorityId", "Update", 11, "2026-09-05T10:01:00"), // dropped field
      log(9005, 1001, "ContactMinistryId", "Update", 18, "2026-09-06T10:00:00", GUID.hlth, GUID.fin), // actor not imported
      log(9006, 1001, "HqComments", "Update", 11, "2026-09-07T10:00:00"), // unknown field
      log(9007, 1008, "Title", "Update", 15, "2026-05-05T10:00:00"), // out of scope
      log(9008, 1002, "IsConfirmed", "Update", null, "2026-09-08T10:00:00", "False", "True"), // no actor
    ],
    logCount: [{ N: 8 }],
    releaseLinks: [{ ActivityId: 1008, N: 2 }, { ActivityId: 1001, N: 1 }], // a release linked before the cutoff
    categories: [lk(2, "Sample awareness day"), lk(12, "Sample approved release"), lk(16, "Sample  speech"), lk(58, "Sample proposed release"), lk(90, "--- OPTIONAL BELOW ---", false), lk(91, null, null)],
    cities: [lk(5, "Sampleton"), lk(311, "Other...")],
    commMaterials: [lk(3, "Sample news release"), lk(61, "Sample unconfirmed marker")],
    eventPlanners: [lk(1, "Sample Planner", true, { PhoneNumber: "250-555-0100", JobTitle: "Sample planner" })],
    governmentRepresentatives: [lk(1, "Sample Representative", true, { Description: "Sample description" })],
    initiatives: [lk(7, "Sample initiative", true, { ShortName: "SI" })],
    keywords: [lk(40, "3-10"), lk(41, "Sample kept keyword")], // "3-10" stays text, never a date
    nrDistributions: [lk(1, "Sample distribution")],
    nrOrigins: [lk(8, "Sample origin")],
    premierRequested: [lk(1, "Sample request")],
    videographers: [lk(1, "Sample videographer", true, { JobTitle: "Sample camera" })],
  };
}

/** The Core state the import expects: three organizations and three terms with legacy ids, and two existing users. */
export async function seedCoreForImport(coreDb: Db): Promise<void> {
  const org = (key: string, displayName: string, abbreviation: string, guid: string, isHq = false) =>
    upsertOrganization(coreDb, { ...healthOrg, key, displayName, abbreviation, sectorKeys: [] }, [], { legacyId: guid.toLowerCase(), isHqOnCreate: isHq });
  await org("finance", "Sample Finance", "FIN", GUID.fin);
  await org("health", "Sample Health", "HLTH", GUID.hlth);
  await org("gcpehq", "Sample HQ", "GCPEHQ", GUID.hq, true);
  const social = { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null };
  await upsertTerm(coreDb, { kind: "sector", key: "sample-sector", displayName: "Sample sector", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.sector.toLowerCase() });
  await upsertTerm(coreDb, { kind: "theme", key: "sample-theme", displayName: "Sample theme", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.theme.toLowerCase() });
  await upsertTerm(coreDb, { kind: "tag", key: "sample-tag", displayName: "Sample tag", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.tag.toLowerCase() });
  await createUser(coreDb, { email: "avery.sample@example.test", displayName: "Avery Core", roles: ["NRMS.Editor"], isActive: true }, []);
  await createUser(coreDb, { email: "blake.sample@example.test", displayName: "Blake Placeholder", roles: [], isActive: false }, []);
}
