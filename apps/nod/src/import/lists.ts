import type { Db } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { lists } from "../db/schema";
import { guidKey, mapLists, type LegacyListRow, type ListMapping } from "./map";
import { Q_LISTS } from "./queries";
import type { NodImportReport } from "./report";

export class NodNotReadyError extends Error {
  constructor() {
    super("NoD has no ministry lists yet: import Core's reference data and let it reach NoD before importing subscribers");
    this.name = "NodNotReadyError";
  }
}

/** Maps legacy lists onto NoD's own (writes nothing: Core and NRMS own list rows). "Imported"
 * in the report means carried to a NoD list. */
export async function importLists(db: Db, source: LegacySource, report: NodImportReport): Promise<ListMapping> {
  const nod = await db.select({ listKey: lists.listKey, category: lists.category, name: lists.name }).from(lists);
  if (!nod.some((l) => l.category === "ministries")) throw new NodNotReadyError();
  const legacy = await source.query<LegacyListRow & Record<string, unknown>>(Q_LISTS);
  const mapping = mapLists(legacy, nod);
  report.count("List", "legacy", legacy.length);
  for (const l of legacy) {
    const guid = guidKey(l.ListGuid);
    if (mapping.byGuid.has(guid)) report.count("List", "imported");
    else report.skip("List", mapping.skipped.get(guid)!, guid);
  }
  return mapping;
}
