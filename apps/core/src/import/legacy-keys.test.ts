import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { GUID, seedCoreForImport } from "../../../calendar/test/legacy-calendar-fixture";
import { loadLegacyKeys } from "./legacy-keys";

describe("loadLegacyKeys", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("resolves legacy GUIDs in any case to Core organizations and terms, and nothing else", async () => {
    await seedCoreForImport(tdb.db);
    const keys = await loadLegacyKeys(tdb.db);
    expect(keys.org(GUID.fin)?.key).toBe("finance");
    expect(keys.org(GUID.fin.toLowerCase())?.abbreviation).toBe("FIN");
    expect(keys.termKey("sector", GUID.sector)).toBe("sample-sector");
    expect(keys.termKey("theme", GUID.sector)).toBeNull(); // right GUID, wrong kind
    expect(keys.org(GUID.unknown)).toBeNull();
  });
});
