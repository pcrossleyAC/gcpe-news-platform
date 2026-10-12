import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb } from "../../../test/helpers";
import { slides } from "../../db/schema";
import { v2Routes } from "./routes";

describe("GET /api/v2/slides", () => {
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
    await tdb.pool.query("TRUNCATE slides");
  });

  const ts = new Date("2026-09-09T23:31:07.521Z");

  it("answers 200 with no-store, slides ordered by sortIndex, emergency true for negative sortIndex, and no image bytes", async () => {
    await tdb.db.insert(slides).values([
      {
        id: "f9adfdc2-5933-4c38-a390-a18077acb213",
        sortIndex: 1,
        headline: "Highlight",
        summary: "s1",
        actionLabel: "READ MORE",
        actionUri: "https://x",
        image: Buffer.from("not-sent"),
        imageType: "image/png",
        imageUrl: "https://files.example/files/slides/aaaa.png",
        imageKey: null,
        imageSha256: null,
        facebookPostUri: null,
        justify: "right",
        timestamp: ts,
      },
      {
        id: "a1a2a3a4-5933-4c38-a390-a18077acb213",
        sortIndex: -2,
        headline: "Emergency",
        summary: "s2",
        actionLabel: null,
        actionUri: null,
        image: null,
        imageType: null,
        imageUrl: null,
        imageKey: null,
        imageSha256: null,
        facebookPostUri: null,
        justify: null,
        timestamp: ts,
      },
    ]);
    const res = await request(app).get("/api/v2/slides");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.slides.map((s: { id: string }) => s.id)).toEqual(["a1a2a3a4-5933-4c38-a390-a18077acb213", "f9adfdc2-5933-4c38-a390-a18077acb213"]);
    expect(res.body.slides[0]).toEqual({
      id: "a1a2a3a4-5933-4c38-a390-a18077acb213",
      sortIndex: -2,
      emergency: true,
      headline: "Emergency",
      summary: "s2",
      actionUri: null,
      actionLabel: null,
      imageUrl: null,
      justify: null,
    });
    expect(res.body.slides[1]).toMatchObject({ id: "f9adfdc2-5933-4c38-a390-a18077acb213", emergency: false, imageUrl: "https://files.example/files/slides/aaaa.png" });
    expect(res.text).not.toContain("not-sent");
    expect(JSON.stringify(res.body)).not.toMatch(/"image":/);
  });

  it("answers 200 with an empty list when there are no slides", async () => {
    const res = await request(app).get("/api/v2/slides");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slides: [] });
  });
});
