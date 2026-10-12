import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mintLocalToken, NEWS_API_CHANGES_ROLE } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../../test/helpers";
import { pruneChanges, recordChanges } from "../../changes";
import { changesBearerFromEnv } from "./changes-auth";
import { parseChangesQuery } from "./changes";
import { v2Routes } from "./routes";

const SECRET = "c".repeat(40);
const token = (roles: string[]) => mintLocalToken({ secret: SECRET, subject: "site-builder", roles });

describe("parseChangesQuery", () => {
  it.each([
    [{}, { ok: true, after: 0, limit: 100 }],
    [{ after: "7", limit: "500" }, { ok: true, after: 7, limit: 500 }],
    [{ after: "007" }, { ok: true, after: 7, limit: 100 }],
  ])("accepts %o", (raw, expected) => expect(parseChangesQuery(raw)).toEqual(expected));

  it.each([
    [{ after: "-1" }, "after"],
    [{ after: "1.5" }, "after"],
    [{ after: "1234567890123456" }, "after"],
    [{ after: "" }, "after"],
    [{ after: ["1", "2"] }, "after"],
    [{ limit: "0" }, "limit"],
    [{ limit: "501" }, "limit"],
    [{ limit: "ten" }, "limit"],
    [{ limit: ["1", "2"] }, "limit"],
  ])("refuses %o, naming %s", (raw, parameter) => {
    expect(parseChangesQuery(raw as Record<string, unknown>)).toMatchObject({ ok: false, parameter });
  });
});

describe("changesBearerFromEnv", () => {
  const local = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: "", LOCAL_AUTH_SECRET: SECRET };
  it("is null with neither Entra nor local admin", () => {
    expect(changesBearerFromEnv({})).toBeNull();
    expect(changesBearerFromEnv({ ENTRA_TENANT_ID: "t" })).toBeNull();
  });
  it("ignores half an Entra setup and never carries a session secret", async () => {
    const { hashPassword } = await import("@gcpe/auth");
    const env = { ...local, LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("pw-for-tests-only"), ENTRA_TENANT_ID: "t", SESSION_SECRET: "s".repeat(40) };
    const bearer = changesBearerFromEnv(env);
    expect(bearer?.local).toEqual({ secret: SECRET });
    expect(bearer?.issuer).toBeUndefined();
    expect(bearer?.session).toBeUndefined();
  });
});

describe("GET /api/v2/changes", () => {
  let tdb: TestDatabase;
  const app = (bearer: { local: { secret: string } } | null) => {
    const a = express();
    a.use("/api/v2", v2Routes({ changes: { db: tdb.db, timeZone: TZ, bearer } }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    await tdb.pool.query("TRUNCATE change_feed_state");
    await tdb.db.transaction((tx) => recordChanges(tx, [{ kind: "post.upserted", key: "R-1" }, { kind: "home", key: null }]));
  });

  it("answers the service role with changes, next, BC-offset times and no-store", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=0&limit=1").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ changes: [{ id: 1, kind: "post.upserted", key: "R-1", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?-0[78]:00$/) }], next: 1 });
  });

  it("lets a Core.Admin token read it too", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes").set("authorization", `Bearer ${await token(["Core.Admin"])}`);
    expect(res.status).toBe(200);
    expect(res.body.next).toBe(2);
  });

  it.each([
    ["no token", undefined, 401],
    ["a token without the role", ["NRMS.Editor"], 403],
  ] as const)("refuses %s with no-store", async (_label, roles, status) => {
    const req = request(app({ local: { secret: SECRET } })).get("/api/v2/changes");
    const res = roles ? await req.set("authorization", `Bearer ${await token([...roles])}`) : await req;
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain("R-1");
  });

  it("refuses a staff session cookie (no bearer token)", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes").set("cookie", "gcpe_session=anything");
    expect(res.status).toBe(401);
  });

  it("answers 503 when the News API has no auth configured", async () => {
    const res = await request(app(null)).get("/api/v2/changes");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "changes feed not configured" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 400 naming the parameter, without echoing it", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=zqxmarker").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(400);
    expect(res.body.error.parameter).toBe("after");
    expect(JSON.stringify(res.body)).not.toContain("zqxmarker");
  });

  it("answers 410 resync with the head when the cursor is older than the oldest kept change", async () => {
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id = 1");
    await pruneChanges(tdb.db);
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=0").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ resync: true, next: 2 });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
