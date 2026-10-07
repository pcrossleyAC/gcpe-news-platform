import type { StatusFilter, SubscriberStatus } from "./types";

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
