import type { ActivityStatus, ChangeAction, ChangeSource, NeedsReviewKey } from "./enums";
import type { ActivityFields, LookAheadFields } from "./input";
import type { LookAheadInference } from "./look-ahead";

/** History field keys (activity_change_fields.field_key) and their labels on "View changes" (spec addendum §8.3). */
export const HISTORY_FIELDS = {
  category: "Category", is_confidential: "Not for Look Ahead", title: "Title", details: "Summary", is_issue: "Issue",
  significance: "Significance", lead_organization: "Lead Organization", initiatives: "HQ Initiatives & Leads", keywords: "HQ Tags",
  comm_contact: "Comm Contact", is_milestone: "Key activity", strategy: "Strategy", comm_materials: "Comm Materials",
  comments: "Internal notes", contact_ministry: "Lead Ministry", is_cross_government: "Cross-Government", shared_with: "Shared With",
  hq_comments: "Executive Summary", hq_status: "LA Status", hq_section: "LA Section", long_term_outlook: "Long Term Outlook",
  start: "Start", end: "End", is_all_day: "All Day", is_confirmed: "Dates Confirmed", potential_dates: "Potential Dates",
  schedule: "Scheduling considerations", nr_at: "Release Time", nr_origins: "Origin", nr_distribution: "Distribution",
  translations: "Translations Required", sectors: "Sectors", themes: "Themes", tags: "News Subscribe",
  premier_requested: "Premier Requested", representative: "Representative", is_at_legislature: "At BC Legislature", city: "City",
  other_city: "Other City", venue: "Venue", event_planner: "Event Planner", videographer: "Digital", status: "Status",
  cloned_from: "Cloned from", files: "Records",
} as const;
export type HistoryFieldKey = keyof typeof HISTORY_FIELDS;

/**
 * The Look Ahead fieldset's history keys. Whoever doesn't see the fieldset on an activity doesn't
 * see these in its history either, nor an entry that recorded only these (spec addendum §6).
 */
export const LOOK_AHEAD_HISTORY_FIELDS = ["hq_comments", "hq_status", "hq_section", "long_term_outlook"] as const satisfies readonly HistoryFieldKey[];

/** One attachment (spec addendum §8.4). The storage key and checksum stay on the server. */
export interface ActivityFileView {
  id: number;
  fileName: string;
  contentType: string;
  length: number;
  uploadedAt: string;
  uploadedByName: string | null;
}

/** A release linked to the activity, from NRMS's release.status_changed (spec addendum §11). */
export interface ReleaseLinkView {
  releaseId: string;
  type: string;
  status: string;
  reference: string | null;
  publishAt: string | null;
  releasedAt: string | null;
}

export interface ActivityView {
  id: number;
  ministryAbbreviation: string | null;
  version: number;
  status: ActivityStatus;
  isDeleted: boolean;
  /** What the editor shows and sends back. `lookAhead` is present only for users who see that fieldset. */
  fields: ActivityFields;
  startAt: string | null;
  endAt: string | null;
  nrAt: string | null;
  lookAhead: (LookAheadFields & { inferred: LookAheadInference }) | null;
  /** The review markup; empty unless the viewer is HQ at Editor and above (spec addendum §6). */
  needsReview: NeedsReviewKey[];
  createdAt: string;
  lastUpdatedAt: string;
  lastUpdatedByName: string | null;
  /** A live edit lock (spec addendum §7.5). */
  lock: { holderName: string; since: string; mine: boolean; tabId: string | null } | null;
  can: { edit: boolean; clone: boolean; delete: boolean; review: boolean };
  /** The watchlist star (Activity.aspx.cs:1519-1535). */
  watch: { isWatched: boolean; watcherNames: string[] };
  files: ActivityFileView[];
  /** "BC Gov News" (spec addendum §8.2, §11); deleted releases are left out. */
  releases: ReleaseLinkView[];
}

export interface ActivityChangeView {
  id: number;
  at: string;
  actorName: string;
  action: ChangeAction;
  source: ChangeSource;
  fields: { key: string; label: string; old: string | null; new: string | null }[];
}

export interface WriteResponse {
  id: number;
  /** Null when the save went through but the writer can't see the result: an HQ Editor below
   * Advanced creating a confidential activity for another ministry, as legacy allowed. */
  activity: ActivityView | null;
  warnings: string[];
}
