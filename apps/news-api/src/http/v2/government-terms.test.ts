import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope, GovernmentTermsPayload } from "@gcpe/events";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb } from "../../../test/helpers";
import { changes } from "../../db/schema";
import { createProjectionHandlers } from "../../projections";
import { v2Routes } from "./routes";

const payload = (publishedAt: string, label = "43rd Parliament"): GovernmentTermsPayload => ({
  publishedAt,
  currentSlug: "43rd",
  terms: [
    { slug: "43rd", label, startDate: "2024-11-18", endDate: null, legacyArchiveUrl: null },
    { slug: "42nd", label: "42nd Parliament", startDate: "2020-11-26", endDate: "2024-11-17", legacyArchiveUrl: "https://archive.example/42nd" },
  ],
});

describe("government terms snapshot", () => {
  let tdb: TestDatabase;
  let app: express.Express;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = express();
    app.use("/api/v2", v2Routes({ db: tdb.db }));
    app.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE government_terms, changes CASCADE");
  });

  const apply = (data: GovernmentTermsPayload) =>
    tdb.db.transaction((tx) => createProjectionHandlers()["government_terms.published"]!(tx, { data, correlationId: "c" } as unknown as EventEnvelope));
  const termChanges = async () => (await tdb.db.select().from(changes)).filter((c) => c.kind === "government_terms");

  it("404 before any payload", async () => {
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("stores and serves a payload", async () => {
    const p = payload("2026-10-27T18:00:00.000Z");
    await apply(p);
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(p);
  });

  it("an older publishedAt is ignored and records no change", async () => {
    await apply(payload("2026-10-27T18:00:00.000Z"));
    await apply(payload("2026-10-27T17:00:00.000Z", "older"));
    await apply(payload("2026-10-27T18:00:00.000Z", "repeat"));
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.body.terms[0].label).toBe("43rd Parliament");
    expect(await termChanges()).toHaveLength(1);
  });

  it("a newer one replaces and records one 'government_terms' change", async () => {
    await apply(payload("2026-10-27T18:00:00.000Z"));
    await apply(payload("2026-10-28T08:00:00.000Z", "renamed"));
    const res = await request(app).get("/api/v2/government-terms");
    expect(res.body.publishedAt).toBe("2026-10-28T08:00:00.000Z");
    expect(res.body.terms[0].label).toBe("renamed");
    const rows = await termChanges();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(expect.objectContaining({ kind: "government_terms", key: null }));
  });
});
