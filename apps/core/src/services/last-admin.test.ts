// Production configuration T5 (owner approved 2026-10-31): with the break-glass admin off, the
// last active Core.Admin is the only way to manage users. Core refuses to deactivate them or take
// Core.Admin away from them, whoever asks, so nobody can lock the site out of user administration.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { calendarAccessRouter } from "../http/calendar-access";
import { usersRouter } from "../http/users";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { roleGrants, users } from "../db/schema";
import { createUser, createUserSchema, getUser, LastAdminError, setRoles, updateUser } from "./users";

const PW = "correct horse battery";

describe("the last active Core.Admin", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.delete(roleGrants);
    await tdb.db.delete(users);
  });
  const make = (email: string, roles: string[], isActive = true) =>
    createUser(tdb.db, createUserSchema.parse({ email, displayName: email, roles, password: PW, isActive }), []);

  it("can't be deactivated, and stays active", async () => {
    const only = await make("only@example.test", ["Core.Admin"]);
    await make("editor@example.test", ["NRMS.Editor"]);
    await make("gone@example.test", ["Core.Admin"], false);
    await expect(updateUser(tdb.db, only.id, { isActive: false }, [])).rejects.toBeInstanceOf(LastAdminError);
    expect((await getUser(tdb.db, only.id))?.isActive).toBe(true);
  });

  it("can't lose Core.Admin, and keeps it", async () => {
    const only = await make("only@example.test", ["Core.Admin", "NRMS.Editor"]);
    await expect(setRoles(tdb.db, only.id, ["NRMS.Editor"], [])).rejects.toBeInstanceOf(LastAdminError);
    expect((await getUser(tdb.db, only.id))?.roles).toEqual(["Core.Admin", "NRMS.Editor"]);
    // Other roles can still change.
    expect((await setRoles(tdb.db, only.id, ["Core.Admin"], [])).roles).toEqual(["Core.Admin"]);
  });

  it("with two, either one can go; then the other is the last", async () => {
    const a = await make("a@example.test", ["Core.Admin"]);
    const b = await make("b@example.test", ["Core.Admin"]);
    expect((await updateUser(tdb.db, a.id, { isActive: false }, [])).isActive).toBe(false);
    await expect(setRoles(tdb.db, b.id, [], [])).rejects.toBeInstanceOf(LastAdminError);
    // Reactivating the first makes room again.
    await updateUser(tdb.db, a.id, { isActive: true }, []);
    expect((await setRoles(tdb.db, b.id, [], [])).roles).toEqual([]);
  });

  it("two admins removed at the same moment: one change wins, the other is refused, one admin is left", async () => {
    const a = await make("a@example.test", ["Core.Admin"]);
    const b = await make("b@example.test", ["Core.Admin"]);
    const results = await Promise.allSettled([updateUser(tdb.db, a.id, { isActive: false }, []), setRoles(tdb.db, b.id, [], [])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused?.reason).toBeInstanceOf(LastAdminError);
    const left = (await Promise.all([getUser(tdb.db, a.id), getUser(tdb.db, b.id)])).filter((u) => u?.isActive && u.roles.includes("Core.Admin"));
    expect(left).toHaveLength(1);
  });

  it("an inactive or non-admin user is never held back by it", async () => {
    const only = await make("only@example.test", ["Core.Admin"]);
    const editor = await make("editor@example.test", ["NRMS.Editor"]);
    const inactiveAdmin = await make("old@example.test", ["Core.Admin"], false);
    expect((await updateUser(tdb.db, editor.id, { isActive: false }, [])).isActive).toBe(false);
    expect((await setRoles(tdb.db, inactiveAdmin.id, [], [])).roles).toEqual([]);
    expect((await updateUser(tdb.db, only.id, { displayName: "Renamed" }, [])).displayName).toBe("Renamed");
  });

  it("the Users routes answer 409 with a plain reason the Hub shows as is", async () => {
    const only = await make("only@example.test", ["Core.Admin"]);
    // Someone else acting (the break-glass admin, say): the self-lockout rule doesn't apply.
    const app = express().use(express.json()).use((req, _res, next) => ((req.auth = { subject: "local:admin", roles: ["Core.Admin"], claims: {} }), next())).use("/users", usersRouter(tdb.db, []));
    const reason = "this is the last active Core Admin: give Core Admin to someone else first, so someone can still manage users";
    const off = await request(app).patch(`/users/${only.id}`).send({ isActive: false });
    expect([off.status, off.body]).toEqual([409, { error: reason }]);
    const drop = await request(app).put(`/users/${only.id}/roles`).send({ roles: ["NRMS.Editor"] });
    expect([drop.status, drop.body]).toEqual([409, { error: reason }]);
    // The Calendar user screen's Deactivate, as a Core admin, says the same (not a 500).
    const cal = express().use(express.json()).use((req, _res, next) => ((req.auth = { subject: "local:admin", roles: ["Core.Admin"], claims: { via: "session" } }), next())).use("/calendar-access", calendarAccessRouter(tdb.db, []));
    const calOff = await request(cal).put(`/calendar-access/${only.id}/active`).send({ isActive: false });
    expect([calOff.status, calOff.body]).toEqual([409, { error: reason }]);
  });
});
