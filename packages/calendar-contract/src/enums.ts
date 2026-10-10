export const ACTIVITY_STATUSES = ["new", "changed", "reviewed"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const HQ_STATUSES = ["new", "changed"] as const;
export type HqStatus = (typeof HQ_STATUSES)[number];
/** Legacy HqSection 1–4 in order (spec addendum §7.6). */
export const HQ_SECTIONS = ["issues_and_reports", "events_and_speeches", "in_the_news", "not_on_la"] as const;
export type HqSection = (typeof HQ_SECTIONS)[number];
/** The 23 needs-review flags (spec addendum §7.3). */
export const NEEDS_REVIEW_KEYS = [
  "title", "details", "representative", "city", "start_date", "end_date", "categories", "comm_materials", "active",
  "significance", "strategy", "scheduling_considerations", "internal_notes", "lead_organization", "initiatives", "tags",
  "origin", "distribution", "translations_required", "premier_requested", "venue", "event_planner", "digital",
] as const;
export type NeedsReviewKey = (typeof NEEDS_REVIEW_KEYS)[number];
export const CHANGE_ACTIONS = ["created", "updated", "cloned", "reviewed", "deleted", "transferred", "la_status_cleared"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];
export const CHANGE_SOURCES = ["calendar", "legacy_log"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];
