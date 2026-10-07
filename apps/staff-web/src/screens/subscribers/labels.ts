import { ApiError } from "../../api/client";
import type { StatusFilter, SubscriberStatus, SyncResultView } from "./types";

export const STATUS_LABELS: Record<SubscriberStatus, string> = {
  pending: "Pending",
  active: "Active",
  disabled: "Disabled",
  deleted: "Unsubscribed or deleted",
};

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "deleted", label: "Unsubscribed or deleted" },
  { value: "pending", label: "Pending" },
];

export function timingLabel(s: { asItHappens: boolean; digest: boolean }): string {
  if (s.asItHappens && s.digest) return "As it happens and daily digest";
  if (s.asItHappens) return "As it happens";
  if (s.digest) return "Daily digest";
  return "None (media lists only)";
}

/** One readable line per `subscriber_history.action` (apps/nod/src/subscribe/history.ts's
 * HISTORY_ACTIONS; labels.test.ts keeps the two in step). */
export const HISTORY_LABELS: Record<string, string> = {
  subscribed: "Subscribed (confirmed by email)",
  resubscribed: "Subscribed again (confirmed by email)",
  confirmed: "Confirmed by email",
  "preferences-updated": "Changed their preferences",
  "email-change-requested": "Asked to change their email address",
  "email-changed": "Changed their email address (confirmed by email)",
  "record-merged": "Took over an earlier record at this address",
  unsubscribed: "Unsubscribed",
  "media-list-added": "Added to a media list",
  "media-list-removed": "Removed from a media list",
  "media-list-opted-out": "Left a media list by unsubscribing",
  "media-ended": "Ended: removed from their last media list",
  "media-hub-email-changed": "Email updated from Media Hub",
  "media-hub-flagged": "Flagged: Media Hub email needs attention",
  "media-hub-resolved": "Media Hub flag resolved",
  "bounce-recorded": "An email bounced",
  "bounce-disabled": "Disabled after repeated bounces",
  "bounce-flagged": "Flagged: repeated bounces",
  "bounce-resolved": "Bouncing flag cleared by staff (bounce count restarts)",
  "staff-added": "Added by staff",
  "staff-preferences-updated": "Preferences changed by staff",
  "staff-email-changed": "Email address changed by staff",
  "staff-activated": "Activated by staff",
  "staff-deactivated": "Deactivated by staff",
  "staff-deleted": "Deleted by staff",
};

export function historyLabel(action: string): string {
  return HISTORY_LABELS[action] ?? action;
}

const SYSTEM_ACTORS: Record<string, string> = {
  subscriber: "Subscriber",
  "distribution-bounce": "Bounce processing",
  "media-hub-sync": "Media Hub sync",
  "admin-api": "Admin API",
};

/** Legacy showed a blank user as "Subscriber" (SubscriberHistory.aspx.cs); staff actors are
 * stored by display name and shown as-is. */
export function actorLabel(actor: string): string {
  return SYSTEM_ACTORS[actor] ?? actor;
}

const ATTENTION_LABELS: Record<string, string> = {
  "email-gone": "Media Hub email removed",
  "email-taken": "Media Hub email belongs to another subscriber",
  "email-invalid": "Media Hub email isn't valid",
  bouncing: "Bouncing",
};
export function attentionLabel(reason: string): string {
  return ATTENTION_LABELS[reason] ?? reason;
}

export function memberSourceLabel(source: string): string {
  if (source === "media-hub") return "Media Hub";
  if (source === "manual-media") return "Added by hand";
  return "Subscriber";
}

export function describeSync(result: SyncResultView | null): string {
  if (!result) return "No sync has run yet.";
  if ("error" in result) return "The last sync stopped with an error. The next run tries again.";
  const text = `${result.contacts} changed contacts: ${result.updated} updated, ${result.flagged} flagged, ${result.removed} removed, ${result.errors} skipped.`;
  return result.inProgress ? `In progress. ${text}` : text;
}

/** What a media-list or Media Hub call's failure means to staff. */
export function mediaErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong.";
  if (e.status === 400) return "That isn't a valid email address.";
  if (e.status === 404) return "That contact or email is no longer in Media Hub.";
  if (e.status === 502) return "Media Hub isn't responding. Try again, or add the address by hand.";
  if (e.status === 503) return "Media Hub isn't set up on this site. Add the address by hand instead.";
  return e.message;
}
