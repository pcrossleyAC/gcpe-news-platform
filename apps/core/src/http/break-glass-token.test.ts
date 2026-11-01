// Owner decision 2026-10-31 (review S M8): a break-glass bearer token from /<app>/auth/local/token
// is a sign-in of its own in Core's session gate, so Sign out ends it in every app, and it keeps
// working (as break-glass cookies do, review S I2) while Core's database is down.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createDb, type TestDatabase } from "@gcpe/db-kit";
import { hashPassword, localLoginRouter, requireBearer, type BearerOptions } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { sessionGate } from "../services/sessions";

const SECRET = "session-secret-for-break-glass-token-tests-01";
const LOCAL_SECRET = "local-secret-for-break-glass-token-tests-0123";
const ADMIN_PW = "break glass password!";

describe("Core: break-glass bearer tokens and Sign out", () => {
  let tdb: TestDatabase;
  let passwordHash: string;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
    passwordHash = await hashPassword(ADMIN_PW);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const build = (db: TestDatabase["db"]) => {
    const local = { username: "admin", passwordHash, secret: LOCAL_SECRET };
    const auth: BearerOptions = { session: { secret: SECRET }, local: { secret: LOCAL_SECRET, breakGlass: { username: "admin", passwordHash } } };
    const gate = sessionGate(db, { localConfigured: true, secret: SECRET });
    const core = createApp({ db, subscribers: [], auth, loginRouter: localLoginRouter(local), session: { secret: SECRET, secure: true, local, ratePerMinute: 1000 }, sessionGate: gate });
    // Another app in the stack, checking with Core's gate.
    const other = express();
    other.get("/x", requireBearer({ local: auth.local, session: { secret: SECRET, gate } }), (_req, res) => void res.json({ ok: true }));
    return { core, other };
  };
  const token = async (core: express.Express) => {
    const res = await request(core).post("/auth/local/token").send({ username: "admin", password: ADMIN_PW });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  };
  const bearer = (t: string) => `Bearer ${t}`;

  it("works in Core and the other apps until signed out with it; then refused everywhere; another token stays", async () => {
    const { core, other } = build(tdb.db);
    const t = await token(core);
    const keep = await token(core);
    expect((await request(core).get("/api/organizations").set("authorization", bearer(t))).status).toBe(200);
    expect((await request(other).get("/x").set("authorization", bearer(t))).status).toBe(200);

    const out = await request(core).post("/auth/logout").set("authorization", bearer(t));
    expect(out.status).toBe(204);
    expect((await request(core).get("/api/organizations").set("authorization", bearer(t))).status).toBe(401);
    expect((await request(other).get("/x").set("authorization", bearer(t))).status).toBe(401);
    expect((await request(other).get("/x").set("authorization", bearer(keep))).status).toBe(200);
  });

  it("Sign out with a token that isn't a current break-glass token is a 401 and ends nothing", async () => {
    const { core } = build(tdb.db);
    expect((await request(core).post("/auth/logout").set("authorization", "Bearer not-a-token")).status).toBe(401);
  });

  it("with Core's database down, a token still works and can still be signed out (held in memory)", async () => {
    const dead = createDb(tdb.url, { max: 1, connectionTimeoutMillis: 500 });
    await dead.pool.end();
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { core, other } = build(dead.db);
      const t = await token(core);
      expect((await request(other).get("/x").set("authorization", bearer(t))).status).toBe(200);
      expect((await request(core).post("/auth/logout").set("authorization", bearer(t))).status).toBe(204);
      expect((await request(other).get("/x").set("authorization", bearer(t))).status).toBe(401);
    } finally {
      warns.mockRestore();
    }
  });
});
