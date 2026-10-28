import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { users } from "../db/schema";
import { authenticate, createUser, createUserSchema, getUser, matchEntraUser, setPassword, unlinkEntra, updateUser, UserLinkedToEntraError } from "./users";

const PW = "a long enough password";

describe("Entra identities on Core users", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const make = async (email: string | null, opts: { roles?: string[]; isActive?: boolean; password?: string } = {}) =>
    createUser(tdb.db, createUserSchema.parse({ email, displayName: `User ${email ?? "no email"}`, roles: opts.roles ?? [], isActive: opts.isActive ?? true, password: opts.password }), []);
  const row = async (id: string) => (await tdb.db.select().from(users).where(eq(users.id, id)))[0]!;

  it("matches by email the first time, links the oid in the same step, then matches by oid", async () => {
    const u = await make("first.match@example.test", { roles: ["NRMS.Editor"] });
    const first = await matchEntraUser(tdb.db, "oid-first", "first.match@example.test");
    expect(first).toEqual({ ok: true, user: { id: u.id, name: u.displayName, email: "first.match@example.test", roles: ["NRMS.Editor"] } });
    expect(await row(u.id)).toMatchObject({ entraOid: "oid-first", signInMethod: "entra" });
    // The email in the token can change later; the oid still finds the user.
    expect(await matchEntraUser(tdb.db, "oid-first", "renamed@example.test")).toMatchObject({ ok: true, user: { id: u.id } });
  });

  it("compares a stored mixed-case email case-insensitively", async () => {
    const [mixed] = await tdb.db.insert(users).values({ email: "Mixed.Case@example.test", displayName: "Mixed Case" }).returning();
    expect(await matchEntraUser(tdb.db, "oid-mixed", "mixed.case@example.test")).toMatchObject({ ok: true, user: { id: mixed!.id } });
  });

  it("refuses an identity with no matching user as not_provisioned, and creates nothing", async () => {
    const before = (await tdb.db.select().from(users)).length;
    expect(await matchEntraUser(tdb.db, "oid-nobody", "nobody@example.test")).toEqual({ ok: false, code: "not_provisioned" });
    expect((await tdb.db.select().from(users)).length).toBe(before);
  });

  it("never matches a user whose email is NULL", async () => {
    const [noEmail] = await tdb.db.insert(users).values({ email: null, displayName: "No Email", isActive: false }).returning();
    expect(await matchEntraUser(tdb.db, "oid-no-email", null)).toEqual({ ok: false, code: "not_provisioned" });
    expect(await matchEntraUser(tdb.db, "oid-no-email", "")).toEqual({ ok: false, code: "not_provisioned" });
    expect(await row(noEmail!.id)).toMatchObject({ entraOid: null, signInMethod: "local" });
  });

  it("refuses an inactive user as inactive, matched by email or by oid, without linking by email", async () => {
    const idle = await make("idle@example.test", { isActive: false });
    expect(await matchEntraUser(tdb.db, "oid-idle", "idle@example.test")).toEqual({ ok: false, code: "inactive", userId: idle.id });
    expect((await row(idle.id)).entraOid).toBeNull();

    const gone = await make("gone@example.test");
    expect(await matchEntraUser(tdb.db, "oid-gone", "gone@example.test")).toMatchObject({ ok: true });
    await updateUser(tdb.db, gone.id, { isActive: false }, []);
    expect(await matchEntraUser(tdb.db, "oid-gone", "gone@example.test")).toEqual({ ok: false, code: "inactive", userId: gone.id });
  });

  it("refuses as conflict when the email's user is linked to a different oid, and changes nothing", async () => {
    const taken = await make("taken@example.test");
    expect(await matchEntraUser(tdb.db, "oid-original", "taken@example.test")).toMatchObject({ ok: true });
    expect(await matchEntraUser(tdb.db, "oid-impostor", "taken@example.test")).toEqual({ ok: false, code: "conflict", userId: taken.id });
    expect((await row(taken.id)).entraOid).toBe("oid-original");
  });

  it("two first sign-ins at once for the same identity both succeed and link once", async () => {
    const u = await make("twice@example.test");
    const [a, b] = await Promise.all([matchEntraUser(tdb.db, "oid-twice", "twice@example.test"), matchEntraUser(tdb.db, "oid-twice", "twice@example.test")]);
    expect(a).toMatchObject({ ok: true, user: { id: u.id } });
    expect(b).toMatchObject({ ok: true, user: { id: u.id } });
    expect((await row(u.id)).entraOid).toBe("oid-twice");
  });

  it("two different identities racing for one email: one links, the other is a conflict", async () => {
    const u = await make("raced@example.test");
    const results = await Promise.all([matchEntraUser(tdb.db, "oid-race-a", "raced@example.test"), matchEntraUser(tdb.db, "oid-race-b", "raced@example.test")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "conflict", userId: u.id }]);
  });

  // The two tests above race on the *same* row, which lockUser's per-user advisory lock fully
  // serialises — neither can reach the isUniqueViolation catch at users.ts:329-333, since the
  // second caller always observes the first's commit through its own locked SELECT, not a
  // colliding UPDATE. This forces the real race the catch guards against:
  // two *different*, not-yet-linked rows, both trying to link the *same* oid. Two raw pg clients
  // hold a FOR UPDATE row lock on each candidate row from outside Drizzle, so both matchEntraUser
  // calls pass their outer, unlocked "oid not yet linked" check (line ~306) and then block on
  // their own per-row SELECT ... FOR UPDATE — exactly the TOCTOU window the catch's own comment
  // describes. Releasing row a's lock first lets it link and commit; releasing row b's lock then
  // makes its UPDATE collide with the now-committed oid on the unique index.
  it("two different unlinked rows racing to link the same oid: the first commit wins, the second gets a clean conflict", async () => {
    const a = await make("race-row-a@example.test");
    const b = await make("race-row-b@example.test");

    const clientA = await tdb.pool.connect();
    const clientB = await tdb.pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [a.id]);
      await clientB.query("BEGIN");
      await clientB.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [b.id]);

      const pA = matchEntraUser(tdb.db, "oid-row-race", "race-row-a@example.test");
      const pB = matchEntraUser(tdb.db, "oid-row-race", "race-row-b@example.test");
      // Wait until both calls are genuinely blocked on the row locks the held clients own (so both
      // have already passed their outer, unlocked "oid not yet linked" check), by polling
      // pg_stat_activity. A fixed sleep here let a slow runner commit row a before row b's call had
      // even started, so b then found the oid already linked and returned ok.
      let blocked = 0;
      for (let i = 0; i < 1000 && blocked < 2; i++) {
        const w = await tdb.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')",
        );
        blocked = w.rows[0].n;
        if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(2);

      await clientA.query("COMMIT");
      expect(await pA).toEqual({ ok: true, user: { id: a.id, name: a.displayName, email: "race-row-a@example.test", roles: [] } });

      await clientB.query("COMMIT");
      expect(await pB).toEqual({ ok: false, code: "conflict", userId: b.id });

      expect((await row(a.id)).entraOid).toBe("oid-row-race");
      expect((await row(b.id)).entraOid).toBeNull();
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  // lower() on both sides of the comparison (users.ts:312,326) means the candidate lookup and
  // the locked re-check both go through Postgres's own lower(), not a
  // mix of it and JS's toLowerCase — so the two queries can't disagree with each other about the
  // very same row. A non-ASCII email already stored in the exact case the Entra claim normalises
  // to (the ordinary case: nobody retypes their own address in a different case) matches and
  // links, with no encoding problem.
  it("matches a non-ASCII stored email", async () => {
    const [u] = await tdb.db.insert(users).values({ email: "jörg.müller@example.test", displayName: "Non-ASCII Email" }).returning();
    expect(await matchEntraUser(tdb.db, "oid-non-ascii", "jörg.müller@example.test")).toMatchObject({ ok: true, user: { id: u!.id } });
  });

  // Postgres's lower() folds non-ASCII letters only under a UTF-8 collation; under the C locale it
  // leaves them alone (Q58). Either way a non-ASCII address must never reach a different user: it
  // either links the user who owns it (UTF-8) or is refused as not_provisioned (C locale).
  it("a non-ASCII email links its own user or is refused, never a different user", async () => {
    const [owner] = await tdb.db.insert(users).values({ email: "INGRID.KRÜGER@example.test", displayName: "Non-ASCII Owner" }).returning({ id: users.id });
    await tdb.db.insert(users).values({ email: "ingrid.kruger@example.test", displayName: "ASCII Lookalike" });
    const result = await matchEntraUser(tdb.db, "oid-non-ascii-owner", "INGRID.KRÜGER@example.test".toLowerCase());
    if (result.ok) expect(result.user.id).toBe(owner!.id);
    else expect(result).toEqual({ ok: false, code: "not_provisioned" });
  });

  it("a linked user is refused at password sign-in like a wrong password", async () => {
    const both = await make("both@example.test", { password: PW });
    expect(await authenticate(tdb.db, "both@example.test", PW)).not.toBeNull();
    await matchEntraUser(tdb.db, "oid-both", "both@example.test");
    expect(await authenticate(tdb.db, "both@example.test", PW)).toBeNull();
  });

  it("usersAllowed: false refuses every user's password", async () => {
    await make("plain@example.test", { password: PW });
    expect(await authenticate(tdb.db, "plain@example.test", PW, { usersAllowed: false })).toBeNull();
    expect(await authenticate(tdb.db, "plain@example.test", PW, { usersAllowed: true })).not.toBeNull();
  });

  it("won't set a password on a linked user; unlink returns them to local sign-in", async () => {
    const linked = await make("linked@example.test");
    await matchEntraUser(tdb.db, "oid-linked", "linked@example.test");
    await expect(setPassword(tdb.db, linked.id, PW)).rejects.toBeInstanceOf(UserLinkedToEntraError);

    const view = await unlinkEntra(tdb.db, linked.id, []);
    expect(view.signInMethod).toBe("local");
    expect(await row(linked.id)).toMatchObject({ entraOid: null, signInMethod: "local" });
    await setPassword(tdb.db, linked.id, PW);
    expect(await authenticate(tdb.db, "linked@example.test", PW)).not.toBeNull();
    // Unlinking an already-local user changes nothing.
    expect((await unlinkEntra(tdb.db, linked.id, [])).signInMethod).toBe("local");
    expect((await getUser(tdb.db, linked.id))!.signInMethod).toBe("local");
  });

  it("the database refuses an Entra sign-in method without an oid, and an oid without it", async () => {
    const u = await make("constraint@example.test");
    await expect(tdb.db.update(users).set({ signInMethod: "entra" }).where(eq(users.id, u.id))).rejects.toMatchObject({ cause: { constraint: "users_entra_link_check" } });
    await expect(tdb.db.update(users).set({ entraOid: "oid-x" }).where(eq(users.id, u.id))).rejects.toMatchObject({ cause: { constraint: "users_entra_link_check" } });
  });
});
