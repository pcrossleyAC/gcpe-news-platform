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
