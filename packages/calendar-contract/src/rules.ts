/** One RLS code: the first rule whose text appears in the activity's comm materials (or origins) wins (ActivityHandler.ashx.cs:1176-1257). */
export interface RlsRule {
  contains: readonly string[];
  code: string;
  /** Not in the Events, Speeches & Releases table: legacy's `inTheNews`, true for Issues and Reports and In the News. */
  notInEvents?: boolean;
  /** False when the NR time never follows this code (legacy's Newsletter fallback). */
  releaseTime?: boolean;
}

/** The report texts and names a tenant supplies (spec addendum §10). BC's are legacy's. */
export interface ReportRules {
  cover: { organization: string; lines: readonly string[] };
  planningTitle: string;
  /** The Lead column's and CC ID#'s abbreviation for these ministries (legacy: GCPEHQ → HQ). */
  leadAbbreviations: Readonly<Record<string, string>>;
  /** The city name that means "not decided yet": no city in the title (ActivityHandler.ashx.cs:1124-1128). */
  cityToBeDecidedName: string;
  /** Dropped from a city's name in the reports (", BC"). */
  citySuffix: string;
  /** An HQ Look Ahead's Category column keeps this category's name instead of "FYI". */
  tvRadioCategoryName: string;
  /** Planning's Significance column: "Issue" when a category name contains this text. */
  issueCategoryText: string;
  /** Planning's Significance column: "FYI Only" when a category name contains this text. */
  fyiOnlyCategoryText: string;
  rlsMaterials: readonly RlsRule[];
  rlsOrigins: readonly RlsRule[];
}

/** What the activity rules read from the tenant's calendar section, plus the tenant's time zone
 * (spec addendum §5.1). The server builds it from @gcpe/config; the browser gets it from GET /calendar/api/config. */
export interface CalendarRules {
  timeZone: string;
  freeze: { start: string; end: string };
  /** Categories that require Origin, Distribution and Comm Materials (legacy 12 and 58). */
  releaseCategoryIds: readonly number[];
  /** Categories whose activities are Awareness Dates (legacy 2; Q52). */
  awarenessCategoryIds: readonly number[];
  /** City "Other…": the Other City text applies only with it. */
  otherCityId: number;
  /** The comm material that marks an unconfirmed issue for the Look Ahead (legacy 61). */
  unconfirmedIssueCommMaterialId: number;
  hqPlaceholderCategoryName: string;
  confidentialCategoryName: string;
  /** Categories an Issue doesn't move to Issues & Reports (Activity.aspx:2493-2497). */
  issueExemptCategoryNames: readonly string[];
  /** Categories that go to Events & Speeches rather than In the News (Activity.aspx:2509-2517). */
  eventsCategoryNames: readonly string[];
  /** Categories whose activities hide the editor's Release fieldset (Scripts/activityhelper.ts:170-196). */
  releaseHiddenCategoryNames: readonly string[];
  consultationsMinistryAbbreviation: string;
  contactMinistryExcludedAbbreviations: readonly string[];
  sharedWithExcludedAbbreviations: readonly string[];
  translationsDefault: readonly string[];
  required: { significance: boolean; scheduling: boolean; strategy: boolean };
  showHqCommentsField: boolean;
  showRecordsSection: boolean;
  /** Keywords a clone keeps; every other keyword is dropped (ActivityWebService.cs:430). */
  cloneKeptKeywordNames: readonly string[];
  lookAheadCoverImage: string | null;
  reportBanner: { province: string; confidentiality: string };
  reports: ReportRules;
}
