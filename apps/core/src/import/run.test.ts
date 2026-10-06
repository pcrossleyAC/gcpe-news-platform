import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createFakeSource } from "@gcpe/legacy-import";
import { createCoreTestDb } from "../../test/helpers";
import { listOrganizations } from "../services/organizations";
import { importLegacyReference } from "./run";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const healthId = "11111111-1111-1111-1111-111111111111";
const ministryRow = {
  Id: healthId, Key: "health", SortOrder: 10, DisplayName: "Health", Abbreviation: "HLTH", IsActive: true,
  MinisterEmail: "SP.Minister@gov.bc.ca", MinisterPhotoUrl: null, MinisterPageHtml: "<p>bio</p>", MinisterAddress: "PO BOX 9050",
  MinisterName: "Honourable Sam Placeholder", MinisterSummary: "Honourable Sam Placeholder", MinistryUrl: "http://gov.bc.ca/health", ParentKey: null,
  WeekendContactNumber: "", DisplayAdditionalName: null, TwitterUsername: "", FlickrUrl: null, YoutubeUrl: null, AudioUrl: null,
  ContactUserId: null, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null,
  SecondContactUserId: null, SecondContactFullName: null, SecondContactPhone: null, SecondContactMobile: null, SecondContactEmail: null,
};
const source = createFakeSource({
  ministries: [ministryRow],
  ministryTopics: [{ MinistryId: healthId, SortIndex: 0, LinkText: "Get immunized", LinkUrl: "https://x" }],
  ministryServices: [],
  ministrySectors: [{ MinistryId: healthId, SectorKey: "health" }],
  sectors: [{ Id: "22222222-2222-2222-2222-222222222222", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health", EnglishName: "Health", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "" }],
  themes: [{ Id: "33333333-3333-3333-3333-333333333333", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health" }],
  tags: [],
  services: [],
});

describe("importLegacyReference", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports organizations and terms and emits events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 1 }, terms: { total: 2, changed: 2 } });
    const [org] = await listOrganizations(tdb.db);
    expect(org!.topicLinks).toEqual([{ text: "Get immunized", url: "https://x" }]);
    expect(org!.sectorKeys).toEqual(["health"]);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });

  it("second import emits no events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 0 }, terms: { total: 2, changed: 0 } });
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });
});
