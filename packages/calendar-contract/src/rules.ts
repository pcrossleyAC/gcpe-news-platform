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
}
