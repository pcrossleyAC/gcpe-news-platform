import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, type SubscriberConfig } from "@gcpe/events";
import { organizations, terms } from "../db/schema";
import { toOrgRecord } from "./organizations";
import { toTermRecord } from "./terms";

export async function republishAll(db: Db, subscribers: SubscriberConfig[]): Promise<number> {
  return db.transaction(async (tx) => {
    let count = 0;
    for (const row of await tx.select().from(organizations)) {
      const record = toOrgRecord(row);
      await enqueueEvent(tx, { type: "org.upserted", source: "core", aggregateId: `org:${record.key}`, data: record }, subscribers);
      count++;
    }
    for (const row of await tx.select().from(terms)) {
      const record = toTermRecord(row);
      await enqueueEvent(
        tx,
        { type: termEventType(record.kind, "upserted"), source: "core", aggregateId: `${record.kind}:${record.key}`, data: record },
        subscribers,
      );
      count++;
    }
    return count;
  });
}
