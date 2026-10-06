import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberHistory } from "../db/schema";

export type HistoryAction = "subscribed" | "confirmed" | "preferences-updated" | "email-change-requested" | "email-changed" | "unsubscribed";

export async function writeHistory(tx: DbOrTx, subscriberId: string, actor: string, action: HistoryAction, detail = ""): Promise<void> {
  await tx.insert(subscriberHistory).values({ subscriberId, actor, action, detail });
}
