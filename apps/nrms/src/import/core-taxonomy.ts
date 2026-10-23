import { asc } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { termEventType, type EventEnvelope } from "@gcpe/events";
import { organizations, terms } from "../../../core/src/db/schema";
import { toOrgRecord } from "../../../core/src/services/organizations";
import { toTermRecord } from "../../../core/src/services/terms";
import { taxonomyHandler } from "../taxonomy";

/**
 * Copies Core's organizations and category terms into NRMS's local cache through the same
 * handler the live events use. Run before releases, so their categories resolve even when the
 * NRMS service wasn't running to receive Core's events while Core was imported.
 */
export async function syncCoreTaxonomy(coreDb: Db, db: Db): Promise<{ organizations: number; terms: number }> {
  const events: Pick<EventEnvelope, "type" | "source" | "data">[] = [
    ...(await coreDb.select().from(organizations).orderBy(asc(organizations.key))).map((row) => ({ type: "org.upserted" as const, source: "core", data: toOrgRecord(row) })),
    ...(await coreDb.select().from(terms).orderBy(asc(terms.kind), asc(terms.key))).map((row) => {
      const record = toTermRecord(row);
      return { type: termEventType(record.kind, "upserted"), source: "core", data: record };
    }),
  ];
  const counts = { organizations: 0, terms: 0 };
  await db.transaction(async (tx) => {
    for (const e of events) {
      const envelope = e as EventEnvelope;
      const handle = taxonomyHandler(envelope);
      if (!handle) continue;
      await handle(tx, envelope);
      if (e.type === "org.upserted") counts.organizations++;
      else counts.terms++;
    }
  });
  return counts;
}
