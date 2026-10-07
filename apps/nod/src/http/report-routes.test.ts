import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { lists, operationsLog, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import type { DistributionClient } from "../distribution-client";

/** A GET whose body stays raw bytes, so a test sees the BOM exactly as sent. */
function getCsv(app: ReturnType<typeof createApp>, path: string, token: string) {
  return request(app)
    .get(path)
    .set("authorization", `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("report routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, outsider: string;
  const distribution = {
    send: vi.fn(),
    getSettings: vi.fn(),
    setPaused: vi.fn(),
    uploadBounce: vi.fn(),
    bounceStats: vi.fn(),
    bounceSource: vi.fn(),
    dailyReport: vi.fn(),
  } as unknown as DistributionClient;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"], "Vic Viewer");
    editor = await token(["NoD.Editor"], "Eddie Editor");
    outsider = await token(["NRMS.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.example", bannerUrl: null },
      distribution,
      timeZone: "America/Vancouver",
    });
    await tdb.db.insert(lists).values([{ listKey: "ministries:health", category: "ministries", key: "health", name: "Health" }]);
    const [pat, formula] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "pat@example.test", status: "active", asItHappens: true, digest: false },
        { email: "=1+2@example.test", status: "active", asItHappens: false, digest: true },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: pat!.id, listKey: "ministries:health" },
      { subscriberId: formula!.id, listKey: "ministries:health" },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => tdb.drop());

  it("reports are for NoD roles only", async () => {
    expect((await request(app).get("/api/reports/subscribers-by-list").set("authorization", `Bearer ${outsider}`)).status).toBe(403);
  });

  it("a Viewer reads counts by list and exports them", async () => {
    const res = await request(app).get("/api/reports/subscribers-by-list").set("authorization", `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    const health = res.body.categories.find((c: { key: string }) => c.key === "ministries").lists[0];
    expect(health).toMatchObject({ listKey: "ministries:health", subscribers: 2, asItHappens: 1, digest: 1 });

    const csv = await getCsv(app, "/api/reports/subscribers-by-list.csv", viewer);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="subscribers-by-list-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (csv.body as Buffer).toString("utf8");
    expect(text.startsWith("﻿Category,List,Subscribers,As it happens,Daily digest\r\n")).toBe(true);
    expect(text).toContain("Ministries,Health,2,1,1\r\n");
    expect(text).not.toContain("@");
  });

  it("a Viewer can't export addresses, even by URL", async () => {
    const res = await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth", viewer);
    expect(res.status).toBe(403);
  });

  it("an Editor exports a list's members with neutralised cells, and the export is logged without addresses", async () => {
    const res = await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth", editor);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="subscribers-ministries-health-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (res.body as Buffer).toString("utf8").split("\r\n");
    expect(lines[0]).toBe("﻿Email,Timing,Source,Registered (BC time)");
    expect(lines[1]).toMatch(/^'=1\+2@example\.test,Daily digest,Signed up,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(lines[2]).toMatch(/^pat@example\.test,As it happens,Signed up,/);
    const [log] = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "report-exported"));
    expect(log).toMatchObject({ actor: "Eddie Editor", detail: "subscribers ministries:health any" });
    expect(log!.detail).not.toContain("@");
  });

  it("an unknown list is a 404 before any CSV starts", async () => {
    const res = await request(app).get("/api/reports/subscribers-by-list/members.csv?list=ministries%3Anope").set("authorization", `Bearer ${editor}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("nothing about an export reaches the logs", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=all", editor);
    await request(app).get("/api/reports/subscribers-by-list/members?list=all").set("authorization", `Bearer ${viewer}`);
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain("pat@example.test");
  });

  describe("recent unsubscribes", () => {
    beforeAll(async () => {
      const [gone] = await tdb.db.insert(subscribers).values({ email: "gone@example.test", status: "deleted" }).returning({ id: subscribers.id });
      await tdb.db.insert(subscriberHistory).values({ subscriberId: gone!.id, actor: "subscriber", action: "unsubscribed" });
    });

    it("a Viewer reads the page and the daily counts CSV, but not the address CSV", async () => {
      const page = await request(app).get("/api/reports/unsubscribes").set("authorization", `Bearer ${viewer}`);
      expect(page.status).toBe(200);
      expect(page.body.items.map((i: { email: string }) => i.email)).toContain("gone@example.test");
      const counts = await getCsv(app, "/api/reports/unsubscribes/daily.csv", viewer);
      expect(counts.status).toBe(200);
      expect((counts.body as Buffer).toString("utf8").split("\r\n")[0]).toBe("﻿Date,New subscriptions,Returning,Unsubscribed,Deleted by staff");
      expect((counts.body as Buffer).toString("utf8")).not.toContain("@");
      expect((await getCsv(app, "/api/reports/unsubscribes.csv", viewer)).status).toBe(403);
    });

    it("an Editor exports the addresses, and the export is logged", async () => {
      const res = await getCsv(app, "/api/reports/unsubscribes.csv", editor);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="unsubscribes-\d{4}-\d{2}-\d{2}\.csv"$/);
      const text = (res.body as Buffer).toString("utf8");
      expect(text.split("\r\n")[0]).toBe("﻿Email,How,When (BC time),Status now,Registered (BC time)");
      expect(text).toMatch(/\r\ngone@example\.test,Unsubscribed,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Deleted,/);
      const logs = await tdb.db.select().from(operationsLog).where(eq(operationsLog.detail, "unsubscribes"));
      expect(logs).toHaveLength(1);
    });
  });
});
