import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { readXlsx } from "../../test/xlsx-read";
import { insertRaw, seedWorld, type World } from "../../test/world";
import { activityCategories } from "../db/schema";
import { CONFIDENTIALITY_NOTICE, EXPORT_HEADERS } from "../list/export";

const q = (o: object) => encodeURIComponent(JSON.stringify(o));
/** Supertest's body parser, for a binary body. */
type BodyParser = Parameters<ReturnType<ReturnType<typeof request>["get"]>["parse"]>[0];
const binary: BodyParser = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("the calendar range and the Excel export (spec addendum §8.1, C151)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const exportAs = (who: keyof World["as"], query: object) =>
    request(app).get(`/api/list/export.xlsx?q=${q(query)}`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  async function act(start: string, end: string, row: object = {}) {
    const id = await insertRaw(tdb.db, { startAt: new Date(start), endAt: new Date(end), ...row });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    return id;
  }

  it("exports the visible rows in legacy's order, with its header cells, 16 columns and red footer, every cell inert", async () => {
    // 2046-03-10 09:00 BC is 16:00Z; BC stays at UTC−7.
    const later = await act("2046-03-11T16:00:00Z", "2046-03-11T17:00:00Z", { title: "=HYPERLINK(\"http://example.test\")" });
    const early = await act("2046-03-10T18:00:00Z", "2046-03-10T19:00:00Z", { title: "Sample early", details: "Sample <b>details</b>", strategy: "Sample strategy" });
    const morning = await act("2046-03-10T16:00:00Z", "2046-03-10T17:00:00Z", { title: "Sample morning", isConfidential: true });
    const secret = await act("2046-03-10T16:30:00Z", "2046-03-10T17:00:00Z", { title: "Sample other ministry secret", contactMinistryKey: "finance", isConfidential: true });
    const res = await exportAs("hqAdvanced", { filter: { from: "2046-03-01", to: "2046-03-31" }, sort: "title", dir: "desc" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="BCGovernmentActivities.xlsx"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const { cells } = readXlsx(res.body as Buffer);
    expect(cells.get("A1")).toBe("Sample Province. Corporate Calendar DRAFT & CONFIDENTIAL");
    expect(cells.get("F1")).toBe("Date Range Selected: Mar 01, 2046 to Mar 31, 2046");
    // FIXED_NOW is 11:00 BC on Tuesday 2026-11-03.
    expect(cells.get("K1")).toBe("Printed: Tue, Nov 3 11:00 AM");
    expect(EXPORT_HEADERS.map((_, i) => cells.get(`${String.fromCharCode(65 + i)}2`))).toEqual([...EXPORT_HEADERS]);
    // HQ Advanced sees every confidential item. Order: start date, end date, start time; the list's sort is ignored.
    expect([3, 4, 5, 6].map((r) => cells.get(`A${r}`))).toEqual([morning, secret, early, later].map(String));
    // The ID column holds numbers, so Excel sorts and filters it as numbers; a number cell can't hold a formula.
    const { files } = readXlsx(res.body as Buffer);
    expect(files.get("xl/worksheets/sheet1.xml")).toContain(`<c r="A3" s="1"><v>${morning}</v></c>`);
    expect(files.get("xl/worksheets/sheet1.xml")).not.toContain("<f>");
    expect(cells.get("E6")).toBe("'=HYPERLINK(\"http://example.test\")");
    expect(cells.get("F5")).toBe("Sample <b>details</b>");
    expect(cells.get("G5")).toBe("Sample significance\n\nStrategy: Sample strategy");
    expect(cells.get("F3")).toBe("Not for Look Ahead Sample details");
    expect(cells.get("A7")).toBe(CONFIDENTIALITY_NOTICE);
  });

  it("an id search's heading names the activity, not the filter's dates, which the search ignored", async () => {
    const found = await act("2046-05-10T17:00:00Z", "2046-05-10T18:00:00Z", { title: "Sample found by id" });
    const res = await exportAs("editor", { filter: { from: "2046-04-01", to: "2046-04-30", quickSearch: `HLTH-${found}` } });
    expect(res.status).toBe(200);
    const { cells } = readXlsx(res.body as Buffer);
    expect(cells.get("F1")).toBe(`Activity ID Selected: ${found}`);
    expect(cells.get("A3")).toBe(String(found));
    const words = readXlsx((await exportAs("editor", { filter: { from: "2046-04-01", to: "2046-04-30", quickSearch: "Sample" } })).body as Buffer);
    expect(words.cells.get("F1")).toBe("Date Range Selected: Apr 01, 2046 to Apr 30, 2046");
  });

  it("an HQ Editor's export leaves out what the list leaves out", async () => {
    await act("2047-01-10T17:00:00Z", "2047-01-10T18:00:00Z", { title: "Sample open" });
    await act("2047-01-10T17:00:00Z", "2047-01-10T18:00:00Z", { title: "Sample secret", contactMinistryKey: "finance", isConfidential: true });
    const { cells } = readXlsx((await exportAs("hqEditor", { filter: { from: "2047-01-01", to: "2047-01-31" } })).body as Buffer);
    const titles = [...cells.entries()].filter(([ref]) => /^E\d+$/.test(ref) && ref !== "E2").map(([, v]) => v);
    expect(titles).toEqual(["Sample open"]);
  });

  it("no field the list hides reaches the file: not the Executive Summary, LA status or review flags, not even by searching them", async () => {
    const marker = "Sample summary marker";
    const own = await act("2047-02-10T17:00:00Z", "2047-02-10T18:00:00Z", { title: "Sample own", hqComments: marker, hqStatus: "changed", needsReview: ["title", "city"] });
    await act("2047-02-10T17:00:00Z", "2047-02-10T18:00:00Z", { title: "Sample finance secret", contactMinistryKey: "finance", isConfidential: true });
    for (const who of ["editor", "hqAdvanced"] as const) {
      const { files, cells } = readXlsx((await exportAs(who, { filter: { from: "2047-02-01", to: "2047-02-28" } })).body as Buffer);
      const sheet = files.get("xl/worksheets/sheet1.xml")!;
      expect(sheet).not.toContain(marker);
      expect([...cells.values()].some((v) => /\bchanged\b|needs review/i.test(v))).toBe(false);
      expect([...cells.entries()].filter(([ref]) => /^A\d+$/.test(ref)).map(([, v]) => v)).toContain(String(own));
      if (who === "editor") expect(sheet).not.toContain("Sample finance secret");
      else expect(sheet).toContain("Sample finance secret");
    }
    // Searching for the Executive Summary they can't see finds nothing: column A holds only the banner, the header and the footer.
    const searched = readXlsx((await exportAs("editor", { filter: { from: "2047-02-01", to: "2047-02-28", quickSearch: marker } })).body as Buffer);
    expect([...searched.cells.entries()].filter(([ref]) => /^A\d+$/.test(ref)).map(([, v]) => v)).toEqual([
      "Sample Province. Corporate Calendar DRAFT & CONFIDENTIAL", "ID", CONFIDENTIALITY_NOTICE,
    ]);
  });

  it("never answers bad input with a 500 or echoes it in a 400", async () => {
    const injected = "<script>Sample</script>";
    const get = (path: string) => request(app).get(path).set("cookie", w.as.editor.cookie);
    const bad = [
      `/api/list/export.xlsx?q=${q({ filter: {}, [injected]: 1 })}`,
      `/api/list/export.xlsx?q=${q({ sort: injected })}`,
      `/api/list/export.xlsx?q=${"1".repeat(8001)}`,
      `/api/list/export.xlsx?q=a&q=b`,
      `/api/list/export.xlsx?q[a]=1`,
      `/api/list/export.xlsx?q=${q({})}&${encodeURIComponent(injected)}=1`,
      `/api/list/export.xlsx`,
      `/api/list/calendar?q=${q({})}&start=${encodeURIComponent(injected)}&end=2049-02-01`,
      `/api/list/calendar?q=${q({})}&start=2049-02-01&end=2049-02-01&start=2049-02-02`,
      `/api/list/calendar?q=${q({})}&start=2049-02-01`,
    ];
    for (const path of bad) {
      const res = await get(path);
      const label = path.slice(0, 120);
      expect(res.status, label).toBe(400);
      expect(res.text, label).not.toContain("script");
      expect(res.headers["content-disposition"], label).toBeUndefined();
    }
  });

  it("refuses more than 10,000 rows with 422, a corporate query below HQ Advanced with 403, and a bad q with 400", async () => {
    await tdb.db.execute(sql`INSERT INTO activities (title, start_at, end_at, contact_ministry_key) SELECT 'Sample bulk ' || g, timestamptz '2048-01-01 17:00Z' + g * interval '1 minute', timestamptz '2048-01-01 18:00Z' + g * interval '1 minute', 'health' FROM generate_series(1, 10001) g`);
    const big = await exportAs("hqAdmin", { filter: { from: "2048-01-01", to: "2048-12-31" } });
    expect(big.status).toBe(422);
    expect(JSON.parse((big.body as Buffer).toString("utf8")).error).toMatch(/10,000/);
    expect((await exportAs("hqEditor", { corporate: { days: 8, statuses: ["new"] } })).status).toBe(403);
    expect((await exportAs("hqEditor", { lookAhead: "look_ahead_only" })).status).toBe(403);
    const corporateRange = request(app).get(`/api/list/calendar?q=${q({ corporate: { days: 8, statuses: ["new"] } })}&start=2049-02-01&end=2049-02-02`);
    expect((await corporateRange.set("cookie", w.as.hqEditor.cookie)).status).toBe(403);
    expect((await request(app).get("/api/list/export.xlsx?q=nope").set("cookie", w.as.editor.cookie)).status).toBe(400);
  });

  it("runs at most two exports at once; a third is told to retry with 503 and Retry-After", async () => {
    const lockWaiters = async () =>
      (await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n;
    const until = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const query = { filter: { from: "2046-03-01", to: "2046-03-31" } };
    let held!: Promise<request.Response>[];
    let third!: { status: number; retryAfter: unknown } | "blocked";
    // Holding the activities table makes the first two exports wait inside the database, still running.
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE activities IN ACCESS EXCLUSIVE MODE`);
      held = [exportAs("hqAdvanced", query).then((r) => r), exportAs("editor", query).then((r) => r)];
      await until(async () => (await lockWaiters()) >= 2);
      expect(await lockWaiters()).toBe(2);
      let res: request.Response | undefined;
      const sent = exportAs("hqEditor", query).then((r) => (res = r));
      await until(async () => res !== undefined || (await lockWaiters()) > 2);
      third = res ? { status: res.status, retryAfter: res.headers["retry-after"] } : "blocked";
      void sent;
    });
    expect(third).toEqual({ status: 503, retryAfter: "5" });
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200]);
    expect((await exportAs("hqEditor", query)).status).toBe(200);
  });

  it("the calendar range: the query's activities overlapping at most 42 days, 1,000 at most", async () => {
    const inside = await act("2049-02-10T17:00:00Z", "2049-02-10T18:00:00Z", { title: "Sample inside" });
    const spanning = await act("2049-01-30T17:00:00Z", "2049-02-02T18:00:00Z", { title: "Sample spanning" });
    await act("2049-03-20T17:00:00Z", "2049-03-20T18:00:00Z", { title: "Sample outside" });
    const range = (query: object, start: string, end: string) => request(app).get(`/api/list/calendar?q=${q(query)}&start=${start}&end=${end}`).set("cookie", w.as.editor.cookie);
    const res = await range({ filter: { quickSearch: "Sample" } }, "2049-02-01", "2049-03-14");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      truncated: false,
      items: [
        { id: spanning, title: "Sample spanning", startAt: "2049-01-30T17:00:00.000Z", endAt: "2049-02-02T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" },
        { id: inside, title: "Sample inside", startAt: "2049-02-10T17:00:00.000Z", endAt: "2049-02-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" },
      ],
    });
    expect((await range({}, "2049-02-01", "2049-03-15")).status).toBe(400);
    expect((await range({}, "2049-02-02", "2049-02-01")).status).toBe(400);
    expect((await range({}, "2049-02-30", "2049-03-01")).status).toBe(400);
    await tdb.db.execute(sql`INSERT INTO activities (title, start_at, end_at, contact_ministry_key) SELECT 'Sample busy ' || g, timestamptz '2050-01-05 17:00Z' + g * interval '1 minute', timestamptz '2050-01-05 18:00Z' + g * interval '1 minute', 'health' FROM generate_series(1, 1001) g`);
    const busy = await range({}, "2050-01-01", "2050-01-31");
    expect(busy.body.items).toHaveLength(1000);
    expect(busy.body.truncated).toBe(true);
  });
});
