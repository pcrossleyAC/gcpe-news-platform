import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { commContacts } from "../db/schema";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie, waitForLockWaiter } from "../../test/helpers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Calendar user routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let admin: string;
  let advanced: string;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectUser(app, { id: id(1), email: "a@example.test", displayName: "Sample Admin", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] });
    await projectUser(app, { id: id(2), email: "b@example.test", displayName: "Sample Advanced", isActive: true, calendarRole: "Calendar.Advanced", organizationKeys: ["health"] });
    admin = await sessionCookie(id(1));
    advanced = await sessionCookie(id(2));
  });
  afterAll(() => tdb.drop());

  const put = (cookie: string, path: string, body: object) => request(app).put(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body);

  it("is Administrator and above only (C140)", async () => {
    expect((await request(app).get("/api/users").set("cookie", advanced)).status).toBe(403);
    expect((await put(advanced, `/api/users/${id(1)}/profile`, { phone: null, mobile: null, jobTitle: null, description: null })).status).toBe(403);
  });

  it("lists, reads, and writes profile and rank", async () => {
    expect((await request(app).get("/api/users").set("cookie", admin)).body).toHaveLength(2);
    expect((await request(app).get("/api/users?inactive=1&noAccess=1").set("cookie", admin)).status).toBe(200);
    expect((await put(admin, `/api/users/${id(2)}/profile`, { phone: "250-555-0101", mobile: null, jobTitle: "Sample", description: null })).status).toBe(200);
    const rank = await put(admin, `/api/users/${id(2)}/comm-contacts/health`, { rank: 3 });
    expect(rank.status).toBe(200);
    expect(rank.body).toEqual([{ ministryKey: "health", rank: 3, isActive: true }]);
    expect((await request(app).get(`/api/users/${id(2)}`).set("cookie", admin)).body.profile.phone).toBe("250-555-0101");
  });

  it("answers 400 with legacy's mobile format, 409 for a ministry the user doesn't hold, 404 for an unknown user", async () => {
    const bad = await put(admin, `/api/users/${id(2)}/profile`, { phone: null, mobile: "(250) 555-0101", jobTitle: null, description: null });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].message).toBe("use 12 digits and hyphens, like 250-555-0100");
    const notHeld = await put(admin, `/api/users/${id(2)}/comm-contacts/finance`, { rank: 2 });
    expect(notHeld.status).toBe(409);
    expect(notHeld.body.error).toBe("finance isn't one of this user's ministries in the Calendar yet: save their ministries first; the Calendar picks them up within a minute");
    expect((await request(app).get(`/api/users/${id(99)}`).set("cookie", admin)).status).toBe(404);
    expect((await put(admin, `/api/users/${id(2)}/comm-contacts/health`, { rank: 7 })).status).toBe(400);
  });

  it("one user's writes share one lock however the id is cased: concurrent PUTs answer 200, never 500", async () => {
    const statuses: number[] = [];
    for (let n = 0; n < 8; n++) {
      const u = `aaaaaaaa-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
      await projectUser(app, { id: u, email: null, displayName: `Sample Racer ${n}`, isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
      const rs = await Promise.all([u, u.toUpperCase()].map((x) => put(admin, `/api/users/${x}/comm-contacts/health`, { rank: 2 })));
      statuses.push(...rs.map((r) => r.status));
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  it("a request for the uppercase id waits for a writer holding the lowercase id's lock", async () => {
    const u = "bbbbbbbb-0000-4000-8000-000000000201";
    await projectUser(app, { id: u, email: null, displayName: "Sample Waiter", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const writer = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-user:${u}`}))`);
      await tx.insert(commContacts).values({ userId: u, ministryKey: "health", rank: 1, isActive: true });
      await held;
    });
    const pending = put(admin, `/api/users/${u.toUpperCase()}/comm-contacts/health`, { rank: 3 }).then((r) => r);
    await waitForLockWaiter(tdb);
    release();
    await writer;
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ ministryKey: "health", rank: 3, isActive: true }]);
  });
});
