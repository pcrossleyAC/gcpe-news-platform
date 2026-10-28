import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb } from "../../../test/helpers";
import { categories } from "../../db/schema";
import { applyOrg, deactivateCategory } from "../../projections";
import { ministrySuccessors, resolveSuccessors } from "../../read";
import { v2Routes } from "./routes";

describe("resolveSuccessors", () => {
  it("follows a chain to the final active ministry", () => {
    expect(resolveSuccessors({ a: ["b"], b: ["c"] }, new Set(["c"]))).toEqual({ a: "c", b: "c" });
  });

  it("drops a cycle", () => {
    expect(resolveSuccessors({ a: ["b"], b: ["a"] }, new Set())).toEqual({});
  });

  it("drops a dead end (a successor that is neither active nor handed over)", () => {
    expect(resolveSuccessors({ a: ["b"] }, new Set(["c"]))).toEqual({});
  });

  it("a split follows the first successor only (N7)", () => {
    expect(resolveSuccessors({ a: ["b", "c"] }, new Set(["b", "c"]))).toEqual({ a: "b" });
    // The first is a dead end: no redirect, even though the second is active.
    expect(resolveSuccessors({ a: ["x", "c"] }, new Set(["c"]))).toEqual({});
  });

  it("an active ministry or an empty list never redirects", () => {
    expect(resolveSuccessors({ a: ["c"], b: [] }, new Set(["a", "c"]))).toEqual({});
  });

  it("gives up after 20 hops", () => {
    const raw: Record<string, string[]> = {};
    for (let i = 0; i < 21; i++) raw[`m${i}`] = [`m${i + 1}`];
    const got = resolveSuccessors(raw, new Set(["m21"]));
    expect(got.m20).toBe("m21");
    expect(got.m1).toBe("m21");
    expect(got.m0).toBeUndefined(); // 21 hops
  });
});

describe("GET /api/v2/ministry-successors", () => {
  let tdb: TestDatabase;
  let app: express.Express;
  const org: OrgRecord = {
    key: "x", displayName: "X", abbreviation: null, sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
    minister: { name: "", summary: "", detailsHtml: "", email: null, photoUrl: null, address: null },
    contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, successorKeys: [], updatedAt: "2026-10-28T09:00:00.000-07:00",
  };
  const ministry = (key: string, extra: Partial<OrgRecord> = {}): OrgRecord => ({ ...org, key, displayName: key, ...extra });
  const apply = (...orgs: OrgRecord[]) => tdb.db.transaction(async (tx) => { for (const o of orgs) await applyOrg(tx, o); });

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
    await tdb.pool.query("TRUNCATE categories, changes CASCADE");
  });

  it("applyOrg stores successorKeys with the ministry", async () => {
    await apply(ministry("b"), ministry("a", { isActive: false, successorKeys: ["b"] }));
    const rows = await tdb.db.select().from(categories);
    expect(rows.find((r) => r.key === "a")!.ministry!.successorKeys).toEqual(["b"]);
  });

  it("serves each inactive ministry's final active successor, lowercased, chains resolved", async () => {
    // A → B, later B → C (Review Focus 4), plus a split D → [E, C], and an active F with a stale list.
    await apply(
      ministry("C"),
      ministry("E"),
      ministry("A", { isActive: false, successorKeys: ["B"] }),
      ministry("B", { isActive: false, successorKeys: ["c"] }),
      ministry("D", { isActive: false, successorKeys: ["e", "C"] }),
      ministry("F", { successorKeys: ["C"] }),
    );
    const res = await request(app).get("/api/v2/ministry-successors");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ successors: { a: "c", b: "c", d: "e" } });
  });

  it("a cycle, a dead end and a non-public target produce no entry; no ministries → {}", async () => {
    expect((await request(app).get("/api/v2/ministry-successors")).body).toEqual({ successors: {} });
    await apply(
      ministry("hidden", { isPublic: false }),
      ministry("a", { isActive: false, successorKeys: ["b"] }),
      ministry("b", { isActive: false, successorKeys: ["a"] }),
      ministry("c", { isActive: false, successorKeys: ["gone"] }),
      ministry("d", { isActive: false, successorKeys: ["hidden"] }),
    );
    expect((await request(app).get("/api/v2/ministry-successors")).body).toEqual({ successors: {} });
  });

  it("a non-public inactive ministry is never a source, but still a hop in a public one's chain", async () => {
    await apply(
      ministry("c"),
      ministry("secret", { isActive: false, isPublic: false, successorKeys: ["c"] }),
      ministry("a", { isActive: false, successorKeys: ["secret"] }),
    );
    expect((await request(app).get("/api/v2/ministry-successors")).body).toEqual({ successors: { a: "c" } });
  });

  it("a row stored before successorKeys existed reads as no successors; deactivation alone adds none", async () => {
    await apply(ministry("b"), ministry("a"));
    await tdb.pool.query("UPDATE categories SET ministry = ministry - 'successorKeys'");
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "a"));
    expect(await ministrySuccessors(tdb.db)).toEqual({});
  });

  it("reactivating clears the redirect (N12)", async () => {
    await apply(ministry("b"), ministry("a", { isActive: false, successorKeys: ["b"] }));
    expect(await ministrySuccessors(tdb.db)).toEqual({ a: "b" });
    await apply(ministry("a", { isActive: true, successorKeys: [] }));
    expect(await ministrySuccessors(tdb.db)).toEqual({});
  });
});
