import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../../core/test/helpers";
import { upsertOrganization } from "../../../core/src/services/organizations";
import { upsertTerm } from "../../../core/src/services/terms";
import { createNrmsTestDb } from "../../test/helpers";
import { categoryTerms, organizations } from "../db/schema";
import { syncCoreTaxonomy } from "./core-taxonomy";

const social = { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null };

describe("syncCoreTaxonomy", () => {
  let core: TestDatabase;
  let nrms: TestDatabase;
  beforeAll(async () => {
    core = await createCoreTestDb();
    nrms = await createNrmsTestDb();
    await upsertOrganization(core.db, healthOrg, []);
    await upsertTerm(core.db, { kind: "sector", key: "Economy", displayName: "Economy", sortOrder: 0, isActive: true, social }, []);
    await upsertTerm(core.db, { kind: "tag", key: "wildfires", displayName: "Wildfires", sortOrder: 1, isActive: false, social }, []);
    await upsertTerm(core.db, { kind: "service", key: "health-cards", displayName: "Health cards", sortOrder: 0, isActive: true, social }, []);
  });
  afterAll(async () => {
    await core.drop();
    await nrms.drop();
  });

  it("fills NRMS's local copy from Core's database, without Core's events having been delivered", async () => {
    expect(await syncCoreTaxonomy(core.db, nrms.db)).toEqual({ organizations: 1, terms: 2 });
    expect((await nrms.db.select().from(organizations)).map((o) => o.key)).toEqual([healthOrg.key.toLowerCase()]);
    const termRows = await nrms.db.select().from(categoryTerms);
    expect(termRows.map((t) => `${t.kind}:${t.key}:${t.isActive}`).sort()).toEqual(["sectors:economy:true", "tags:wildfires:false"]);
  });

  it("is safe to run again", async () => {
    expect(await syncCoreTaxonomy(core.db, nrms.db)).toEqual({ organizations: 1, terms: 2 });
    expect(await nrms.db.select().from(categoryTerms)).toHaveLength(2);
  });
});
