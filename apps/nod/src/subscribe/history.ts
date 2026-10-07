import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberHistory } from "../db/schema";

/** Every action `subscriber_history` holds; staff-web's History screen has a label for each
 * (apps/staff-web/src/screens/subscribers/labels.test.ts checks they stay in step).
 * `confirmed` is no longer written -- rows from before the subscribed/resubscribed split keep it. */
export const HISTORY_ACTIONS = [
  "subscribed",
  "resubscribed",
  "confirmed",
  "preferences-updated",
  "email-change-requested",
  "email-changed",
  "record-merged",
  "unsubscribed",
  "media-list-added",
  "media-list-removed",
  "media-list-opted-out",
  "media-ended",
  "media-hub-email-changed",
  "media-hub-flagged",
  "media-hub-resolved",
  "bounce-recorded",
  "bounce-disabled",
  "bounce-flagged",
  "bounce-resolved",
  "staff-added",
  "staff-preferences-updated",
  "staff-email-changed",
  "staff-activated",
  "staff-deactivated",
  "staff-deleted",
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export async function writeHistory(tx: DbOrTx, subscriberId: string, actor: string, action: HistoryAction, detail = ""): Promise<void> {
  await tx.insert(subscriberHistory).values({ subscriberId, actor, action, detail });
}
