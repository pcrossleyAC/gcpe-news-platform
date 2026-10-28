import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb } from "../../../test/helpers";
import { categories } from "../../db/schema";
import { applyOrg } from "../../projections";
import { v2Routes } from "./routes";

const org = (key: string, over: Partial<OrgRecord> = {}): OrgRecord => ({
  key,
  displayName: key,
  abbreviation: null,
  sortOrder: 0,
  isActive: true,
  parentKey: null,
  url: null,
  displayAdditionalName: null,
  minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
  contact: null,
  secondContact: null,
  weekendContactNumber: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  updatedAt: "2026-10-08T17:00:00Z",
  ...over,
});

describe("GET /api/v2/ministries", () => {
  let tdb: TestDatabase;
  let app: express.Express;
  const apply = (o: OrgRecord) => tdb.db.transaction((tx) => applyOrg(tx, o));

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = express();
    app.use("/api/v2", v2Routes({ db: tdb.db }));
    app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    await apply(
      org("health", {
        minister: { name: "A", summary: null, detailsHtml: null, email: "a@gov.bc.ca", photoUrl: null, address: null },
        teamLinks: [{ text: "Deputy", url: "https://example.com/d" }],
      }),
    );
    await apply(org("health-b", { parentKey: "Health", sortOrder: 2 }));
    await apply(org("health-a", { parentKey: "health", sortOrder: 1 }));
    await apply(org("health-old", { parentKey: "health", sortOrder: 0, isActive: false }));
    await apply(org("secret", { isPublic: false }));
    // A row stored before teamLinks existed: no teamLinks in the jsonb.
    await tdb.db.insert(categories).values({
      kind: "ministries",
      key: "legacy",
      name: "legacy",
      sortOrder: 5,
      isActive: true,
      isPublic: true,
      social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
      ministry: { parentKey: null, url: null, displayAdditionalName: null, minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null, weekendContactNumber: null, topicLinks: [], serviceLinks: [] },
      timestamp: new Date(),
    });
  });
  afterAll(() => tdb.drop());

  const list = async () => (await request(app).get("/api/v2/ministries").expect(200)).body.ministries as { key: string; ministerEmail: string | null; teamLinks: unknown[]; childKeys: string[] }[];

  it("lists public ministries with ministerEmail, teamLinks and childKeys; a non-public ministry is absent", async () => {
    const byKey = new Map((await list()).map((m) => [m.key, m]));
    expect(byKey.has("secret")).toBe(false);
    expect(byKey.get("health")).toEqual({ key: "health", ministerEmail: "a@gov.bc.ca", teamLinks: [{ text: "Deputy", url: "https://example.com/d" }], childKeys: expect.any(Array) });
    expect(byKey.get("health-a")).toEqual({ key: "health-a", ministerEmail: null, teamLinks: [], childKeys: [] });
  });

  it("a ministry stored before teamLinks existed answers teamLinks: []", async () => {
    expect((await list()).find((m) => m.key === "legacy")!.teamLinks).toEqual([]);
  });

  it("childKeys holds only active public children, ordered by sortOrder", async () => {
    expect((await list()).find((m) => m.key === "health")!.childKeys).toEqual(["health-a", "health-b"]);
  });

  it("is no-store", async () => {
    expect((await request(app).get("/api/v2/ministries")).headers["cache-control"]).toBe("no-store");
  });
});
