import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { breakGlassFingerprint } from "@gcpe/auth";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "./organizations";
import { setCalendarAccess } from "./calendar-access";
import { BREAK_GLASS_ID, breakGlassSessionKnown, endSession, sessionGate, startSession } from "./sessions";
import { createUser, createUserSchema, sessionUserFor, setRoles, updateUser } from "./users";

const SECRET = "session-secret-for-gate-tests-0123456789";
const now = () => Math.floor(Date.now() / 1000);
const v = (id: string, sid?: string, pwf?: string) => ({ id, name: "x", email: "", roles: [], expiresAt: now() + 60, signedAt: now(), ...(sid ? { sid } : {}), ...(pwf ? { pwf } : {}) });
const GLASS = { secret: "local-secret-for-gate-tests-0123456789", passwordHash: "scrypt$16384$8$1$salt$hash-one" };
const PWF = breakGlassFingerprint(GLASS.secret, GLASS.passwordHash);

describe("Core's session gate", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("gives the person exactly as sessionUserFor does, Calendar role included, in one query", async () => {
    await upsertOrganization(tdb.db, healthOrg, []);
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "gate@example.test", displayName: "Gate Person", roles: ["NRMS.Viewer", "NoD.Editor"], password: "gate password 123" }), []);
    const admin = { id: "admin", roles: ["Core.Admin"] };
    await setCalendarAccess(tdb.db, admin, u.id, { role: "Calendar.Editor", organizationKeys: [healthOrg.key] }, []);
    const sid = await startSession(tdb.db, u.id, now());
    const gate = sessionGate(tdb.db, { breakGlass: null, secret: SECRET });
    expect(await gate(v(u.id, sid))).toEqual(await sessionUserFor(tdb.db, u.id));
    expect((await gate(v(u.id, sid)))!.roles).toContain("Calendar.Editor");
    await setRoles(tdb.db, u.id, [], []);
    expect(await gate(v(u.id, sid))).toEqual(await sessionUserFor(tdb.db, u.id));
  });

  it("refuses an unknown or ended session, someone else's session id, an unknown or inactive person, and break-glass once its settings are gone", async () => {
    const a = await createUser(tdb.db, createUserSchema.parse({ email: "gate-a@example.test", displayName: "A", roles: [] }), []);
    const b = await createUser(tdb.db, createUserSchema.parse({ email: "gate-b@example.test", displayName: "B", roles: [] }), []);
    const gate = sessionGate(tdb.db, { breakGlass: GLASS, secret: SECRET });
    const sidA = await startSession(tdb.db, a.id, now());
    expect(await gate(v(a.id, sidA))).not.toBeNull();
    expect(await gate(v(a.id))).not.toBeNull(); // a pre-limit token: active is enough
    expect(await gate(v(a.id, "no-such-sid"))).toBeNull();
    expect(await gate(v(b.id, sidA))).toBeNull();
    expect(await gate(v("00000000-0000-4000-8000-000000000000"))).toBeNull();
    expect(await gate(v("not-a-uuid"))).toBeNull();
    await endSession(tdb.db, sidA, a.id);
    expect(await gate(v(a.id, sidA))).toBeNull();
    const sidB = await startSession(tdb.db, b.id, now());
    await updateUser(tdb.db, b.id, { isActive: false }, []);
    expect(await gate(v(b.id))).toBeNull();
    await updateUser(tdb.db, b.id, { isActive: true }, []);
    expect(await gate(v(b.id, sidB))).toBeNull(); // ended by the deactivation, for good
    expect(await gate(v(b.id))).not.toBeNull();

    const glass = await startSession(tdb.db, BREAK_GLASS_ID, now());
    expect(await gate(v(BREAK_GLASS_ID, glass, PWF))).toMatchObject({ id: BREAK_GLASS_ID });
    expect(await sessionGate(tdb.db, { breakGlass: null, secret: SECRET })(v(BREAK_GLASS_ID, glass, PWF))).toBeNull();
  });

  // Review BG M1: a break-glass sign-in stands only while the password it was made with is current.
  it("refuses a break-glass session whose password fingerprint is missing or no longer current", async () => {
    const glass = await startSession(tdb.db, BREAK_GLASS_ID, now());
    const gate = sessionGate(tdb.db, { breakGlass: GLASS, secret: SECRET });
    expect(await gate(v(BREAK_GLASS_ID, glass, PWF))).not.toBeNull();
    expect(await gate(v(BREAK_GLASS_ID, glass))).toBeNull();
    const changed = sessionGate(tdb.db, { breakGlass: { ...GLASS, passwordHash: "scrypt$16384$8$1$salt$hash-two" }, secret: SECRET });
    expect(await changed(v(BREAK_GLASS_ID, glass, PWF))).toBeNull();
  });

  // Review S N2: the in-memory break-glass list doesn't grow for ever.
  it("forgets break-glass sessions older than the limit plus an hour when a new one starts", async () => {
    const old = await startSession(tdb.db, BREAK_GLASS_ID, now() - 13 * 3600 - 60);
    const recent = await startSession(tdb.db, BREAK_GLASS_ID, now() - 11 * 3600);
    expect(breakGlassSessionKnown(old)).toBe(false);
    expect(breakGlassSessionKnown(recent)).toBe(true);
  });
});
