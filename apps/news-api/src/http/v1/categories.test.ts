import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { createApp } from "../../app";
import { problemNotFound } from "../errors";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";

const base: Omit<OrgRecord, "key" | "displayName" | "parentKey" | "isActive" | "sortOrder"> = {
  abbreviation: null, url: null, displayAdditionalName: null,
  minister: { name: "Hon. X", summary: "Hon. X", detailsHtml: "", email: "", photoUrl: null, address: null },
  contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, updatedAt: "2026-10-02T16:46:05.527-07:00",
};
const org = (key: string, sortOrder: number, parentKey: string | null, isActive = true): OrgRecord => ({ ...base, key, displayName: key, sortOrder, parentKey, isActive });

describe("category and site endpoints", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const V = "api-version=1.0";

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    for (const o of [org("forests", 1, null), org("sustainable-forestry-innovation", 2, "forests", false), org("premier", 0, null), org("local-gov", 3, "premier")]) {
      await sendEvent(app, envelope("core", "org.upserted", `org:${o.key}`, o));
    }
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:premier", { entity: "categoryFeatures", kind: "ministries", key: "premier", topPostKey: "T", featurePostKey: "F" }));
    await sendEvent(app, envelope("core", "sector.upserted", "sector:economy", { kind: "sector", key: "economy", displayName: "Economy", sortOrder: 0, isActive: true, social: base.social, updatedAt: base.updatedAt }));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("400 without api-version, 400 for unsupported versions", async () => {
    const missing = await request(app).get("/api/Ministries");
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: { code: "ApiVersionUnspecified", message: "An API version is required, but was not specified.", innerError: null } });
    expect(missing.headers["cache-control"]).toBe("no-cache");
    const bad = await request(app).get("/api/Ministries?api-version=2.0");
    expect(bad.body.error.code).toBe("UnsupportedApiVersion");
    expect((await request(app).get("/api/Ministries?api-version=1")).status).toBe(200);
  });

  it("lists ministries in sort order with active child keys only", async () => {
    const res = await request(app).get(`/api/Ministries?${V}`);
    expect(res.body.map((m: { key: string }) => m.key)).toEqual(["premier", "forests", "sustainable-forestry-innovation", "local-gov"]);
    const byKey = Object.fromEntries(res.body.map((m: { key: string }) => [m.key, m]));
    expect(byKey.premier.childMinistryKey).toBe("local-gov");
    expect(byKey.forests.childMinistryKey).toBeNull();
    expect(byKey.premier.topPostKey).toBe("T");
  });

  it("looks up ministries case-insensitively and returns empty 200 when missing", async () => {
    expect((await request(app).get(`/api/Ministries/PREMIER?${V}`)).body.key).toBe("premier");
    const missing = await request(app).get(`/api/Ministries/nope?${V}`);
    expect(missing.status).toBe(200);
    expect(missing.text).toBe("");
    expect((await request(app).get(`/api/ministries/premier/minister?${V}`)).body.headline).toBe("Hon. X");
  });

  it("serves sectors and an empty home", async () => {
    expect((await request(app).get(`/api/Sectors/ECONOMY?${V}`)).body.name).toBe("Economy");
    expect((await request(app).get(`/api/Sectors/zz?${V}`)).text).toBe("");
    const home = await request(app).get(`/api/Home?${V}`);
    expect(home.body).toMatchObject({ kind: "home", key: "default", topPostKey: null });
    expect(home.headers["cache-control"]).toBe("no-cache");
  });

  it("returns empty 200 for a slide id that is 36 characters but not a valid UUID", async () => {
    const res = await request(app).get(`/api/Slides/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?${V}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });
});

describe("error handling", () => {
  it("returns 500 JSON without a stack when a route handler throws, and never bare HTML", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("boom");
      },
    } as unknown as Db;
    const errApp = createApp({ db: brokenDb, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const res = await request(errApp).get("/api/Ministries?api-version=1.0");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "internal error" });
    expect(res.text).not.toMatch(/at \S+ \(|\.ts:\d+:\d+/);
  });
});

describe("problemNotFound", () => {
  it("sends a 404 problem+json body with the problem content type", async () => {
    const probeApp = express();
    probeApp.get("/probe", (_req, res) => problemNotFound(res));
    const res = await request(probeApp).get("/probe");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(res.body).toMatchObject({
      type: "https://tools.ietf.org/html/rfc7231#section-6.5.4",
      title: "Not Found",
      status: 404,
    });
    expect(res.body.traceId).toMatch(/^\|[0-9a-f]{8}-[0-9a-f]{8}\.$/);
  });
});

// Final review M1: event types are restricted by source — Core owns reference data, NRMS owns
// releases and site content. A correctly-signed event of the other source's family is
// recorded as "ignored", never applied.
describe("event source restrictions", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const V = "api-version=1.0";

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    expect((await sendEvent(app, envelope("core", "org.upserted", "org:health", org("health", 0, null)))).outcome).toBe("applied");
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("ignores an nrms-signed org.deactivated", async () => {
    const res = await sendEvent(app, envelope("nrms", "org.deactivated", "org:health", { key: "health" }));
    expect(res.outcome).toBe("ignored");
    expect((await request(app).get(`/api/Ministries?${V}`)).body.map((m: { key: string }) => m.key)).toEqual(["health"]);
  });

  it("ignores an nrms-signed org.upserted / sector.upserted", async () => {
    expect((await sendEvent(app, envelope("nrms", "org.upserted", "org:evil", org("evil", 0, null)))).outcome).toBe("ignored");
    const sector = { kind: "sector", key: "evil", displayName: "Evil", sortOrder: 0, isActive: true, social: base.social, updatedAt: base.updatedAt };
    expect((await sendEvent(app, envelope("nrms", "sector.upserted", "sector:evil", sector))).outcome).toBe("ignored");
    expect((await request(app).get(`/api/Ministries/evil?${V}`)).text).toBe("");
  });

  it("ignores core-signed release and site-content events", async () => {
    const site = { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "T", featurePostKey: "F" };
    expect((await sendEvent(app, envelope("core", "site.content.changed", "site:feature:ministries:health", site))).outcome).toBe("ignored");
    expect((await sendEvent(app, envelope("core", "release.unpublished", "release:x", { key: "x" }))).outcome).toBe("ignored");
    expect((await request(app).get(`/api/Ministries/health?${V}`)).body.topPostKey).toBeNull();
  });

  it("still applies each source's own families", async () => {
    const site = { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "T", featurePostKey: "F" };
    expect((await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:health:2", site))).outcome).toBe("applied");
    expect((await sendEvent(app, envelope("core", "org.deactivated", "org:health", { key: "health" }))).outcome).toBe("applied");
  });
});
