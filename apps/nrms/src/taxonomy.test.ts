import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createNrmsTestDb } from "../test/helpers";
import { listCategories, ministryAbbreviation, ministryName, taxonomyHandler } from "./taxonomy";

const ev = (type: string, data: unknown, source = "core") => ({ id: crypto.randomUUID(), type, source, aggregateId: "x", sequence: 1, occurredAt: new Date().toISOString(), data }) as unknown as EventEnvelope;

describe("taxonomy cache", () => {
  let tdb: TestDatabase;
  const apply = async (e: EventEnvelope) => tdb.db.transaction(async (tx) => taxonomyHandler(e)!(tx, e));
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("ignores other sources and unrelated types", () => {
    expect(taxonomyHandler(ev("org.upserted", {}, "nrms"))).toBeUndefined();
    expect(taxonomyHandler(ev("release.published", {}))).toBeUndefined();
    expect(taxonomyHandler(ev("service.upserted", {}))).toBeUndefined();
  });

  it("upserts and deactivates ministries and categories", async () => {
    await apply(ev("org.upserted", { key: "Health", displayName: "Health", abbreviation: "HLTH", sortOrder: 2, isActive: true }));
    await apply(ev("org.upserted", { key: "finance", displayName: "Finance", abbreviation: "FIN", sortOrder: 1, isActive: true }));
    await apply(ev("sector.upserted", { kind: "sector", key: "health", displayName: "Health", sortOrder: 0, isActive: true }));
    await apply(ev("tag.upserted", { kind: "tag", key: "covid-19", displayName: null, sortOrder: 0, isActive: true }));
    expect(await ministryAbbreviation(tdb.db, "health")).toBe("HLTH");
    expect(await ministryName(tdb.db, "HEALTH")).toBe("Health");
    expect(await listCategories(tdb.db)).toEqual({
      ministries: [{ key: "finance", name: "Finance", abbreviation: "FIN" }, { key: "health", name: "Health", abbreviation: "HLTH" }],
      sectors: [{ key: "health", name: "Health" }],
      themes: [],
      tags: [{ key: "covid-19", name: "covid-19" }],
    });
    await apply(ev("org.deactivated", { key: "finance" }));
    await apply(ev("tag.deactivated", { kind: "tag", key: "covid-19" }));
    const after = await listCategories(tdb.db);
    expect(after.ministries.map((m) => m.key)).toEqual(["health"]);
    expect(after.tags).toEqual([]);
    expect(await ministryAbbreviation(tdb.db, "finance")).toBe("FIN"); // still resolvable for old releases
  });
});
