/**
 * Mirrors apps/nod/src/staff-subscribers/{read,actions}.ts's shapes — defined locally since
 * browser code can't import apps/nod (a Node-only package). Every date is an ISO `string`
 * here, never a `Date` (the server sends JSON; `Date` only exists again after `new Date(iso)`).
 */

export const SUBSCRIBER_STATUSES = ["pending", "active", "disabled", "deleted"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];
export type StatusFilter = "all" | SubscriberStatus;

export interface SubscriberSummary {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: string;
  asItHappens: boolean;
  digest: boolean;
  createdAt: string;
  needsAttention: string | null;
}

export interface SubscriberPage {
  total: number;
  page: number;
  pageSize: number;
  items: SubscriberSummary[];
}

export interface SubscriberDetail extends SubscriberSummary {
  verifiedAt: string | null;
  endedAt: string | null;
  attentionAt: string | null;
  allNews: boolean;
  /** Public list keys (`<category>:<key>`), never `*` (see allNews) or a media key. */
  listKeys: string[];
  mediaLists: { listKey: string; name: string }[];
  /** Media Hub manages this address (sourced from it, or linked to a contact), so it's changed
   * there, not here. */
  mediaHubLinked: boolean;
  /** Why a `disabled` subscriber is disabled; null when not disabled or unexplained. */
  disabledReason: "bounces" | "staff" | null;
  bouncedEmails: number;
  bounceWindowDays: number;
}

export interface HistoryEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface ListOptions {
  categories: { key: string; name: string; lists: { listKey: string; name: string }[] }[];
}

export const BULK_ACTIONS = ["activate", "deactivate", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Why a bulk row didn't change: no such subscriber, already in the target state, a status the
 * action can't apply to, or an unexpected failure on that row alone (worth retrying). */
export type BulkSkipReason = "not-found" | "unchanged" | "status" | "error";
export interface BulkResult {
  changed: number;
  skipped: { id: string; reason: BulkSkipReason }[];
}

/** apps/nod/src/staff-lists.ts */
export interface StaffList {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  enabled: boolean;
  subscribers: number;
}
export interface StaffCategory {
  key: string;
  name: string;
  enabled: boolean;
  namesFrom: "Core" | "NRMS" | "NoD";
  editable: boolean;
  lists: StaffList[];
}
export interface StaffListsView {
  allNews: number;
  categories: StaffCategory[];
}

/** apps/nod/src/media-members.ts */
export interface MediaListSummary {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  members: number;
  needsAttention: number;
}
export interface MediaMember {
  subscriberId: string;
  email: string;
  source: string;
  mediaHubContactId: number | null;
  mediaHubEmailRef: string | null;
  needsAttention: string | null;
  attentionAt: string | null;
}
export interface MediaOptOut {
  subscriberId: string;
  email: string;
  at: string;
  member: boolean;
}
export interface MediaOptOutPage {
  items: MediaOptOut[];
  truncated: boolean;
}
export type AddMemberBody = { email: string; confirmOptOut?: boolean } | { mediaHubContactId: number; emailRef: string; confirmOptOut?: boolean };

/** apps/nod/src/media-hub/contract.ts */
export interface MediaHubEmail {
  ref: string;
  address: string;
  kind: "personal" | "workplace";
  organization: string | null;
  preferred: boolean;
}
export interface MediaHubContact {
  id: number;
  firstName: string;
  lastName: string;
  outlet: string | null;
  emails: MediaHubEmail[];
  deletedAt: string | null;
}
export interface MediaHubContactPage {
  contacts: MediaHubContact[];
  page: number;
  pageSize: number;
  total: number;
}

/** apps/nod/src/media-hub/sync.ts StoredSyncResult / getMediaSyncStatus */
export type SyncResultView =
  | { contacts: number; updated: number; flagged: number; removed: number; errors: number; inProgress?: true }
  | { error: string; kind?: string };
export interface SyncStatus {
  since: string | null;
  at: string | null;
  result: SyncResultView | null;
  running: boolean;
}

/** apps/nod/src/purge.ts */
export interface PurgeCounts {
  pendingSubscribers: number;
  endedSubscribers: number;
  unusedLinks: number;
  expiredSendLinks: number;
}
export interface PurgeRunResult {
  cutoff: string;
  counts: PurgeCounts;
  finished: boolean;
  enabled: boolean;
}
export interface PurgeStatus {
  enabled: boolean;
  preview: PurgeCounts;
  lastRun: PurgeRunResult | null;
  nextRunAt: string;
}

/** apps/nod/src/emergency/ingest.ts */
export interface EmergencyFeedResult {
  at: string;
  ok: boolean;
  seeded: boolean;
  inFeed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
}
export interface EmergencyFeedStatus {
  url: string | null;
  checkedAt: string | null;
  result: EmergencyFeedResult | null;
}

/** apps/nod/src/operations.ts */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: { address: string | null; from: "setting" | "server" | null };
  softCodesCounted: string[];
  purge: PurgeStatus;
  emergencyFeed: EmergencyFeedStatus;
}
