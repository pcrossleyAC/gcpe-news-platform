import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, EVENT_SECRETS, FIXED_NOW, projectUser, sessionCookie, SESSION_SECRET, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { createApp } from "../app";
import { activityCategories } from "../db/schema";
import { REPORT_PER_USER_MAX, REPORT_QUEUE_MAX, REPORT_TTL_MS, ReportJobs } from "../reports/jobs";
import type { ReportDoc } from "../reports/model";
import { ReportRenderError, type PdfRenderer } from "../reports/render/renderer";

/** Supertest's body parser, for a binary body. */
type BodyParser = Parameters<ReturnType<ReturnType<typeof request>["get"]>["parse"]>[0];
const binary: BodyParser = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** A renderer that answers when told to, recording what it was given. */
function fakeRenderer() {
  const docs: ReportDoc[] = [];
  let hold = false;
  const waiting: (() => void)[] = [];
  let fail: Error | null = null;
  const renderer: PdfRenderer = {
    async render(doc) {
      docs.push(doc);
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
      if (fail) throw fail;
      return new TextEncoder().encode(`%PDF-sample ${doc.title}`);
    },
    close: async () => {},
  };
  return {
    renderer, docs,
    hold: () => void (hold = true),
    release: () => { hold = false; waiting.splice(0).forEach((f) => f()); },
    failWith: (e: Error | null) => void (fail = e),
  };
}

const MARCH = { filter: { from: "2046-03-01", to: "2046-03-31" } };

describe("the report routes (spec addendum §10)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let fake: ReturnType<typeof fakeRenderer>;
  let jobs: ReportJobs;
  let clock = FIXED_NOW.getTime();
  const start = (who: Who, report: string, q: object = MARCH) => call(app, "post", `/api/reports/${report}`, w.as[who].cookie, { q });
  const poll = (who: Who, id: string) => call(app, "get", `/api/reports/jobs/${id}`, w.as[who].cookie);
  const pdf = (who: Who, id: string) => request(app).get(`/api/reports/jobs/${id}/pdf`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    fake = fakeRenderer();
    jobs = new ReportJobs({ renderer: fake.renderer, concurrency: 1, now: () => clock });
    app = createTestApp(tdb.db, { reports: { jobs, inlineWaitMs: 200 } });
    w = await seedWorld(app, tdb.db);
    const id = await insertRaw(tdb.db, { title: "Sample routed", startAt: new Date("2046-03-10T16:00:00Z"), endAt: new Date("2046-03-10T17:00:00Z") });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
  });
  afterEach(() => {
    fake.release();
    fake.failWith(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await jobs.close();
    await tdb.drop();
  });

  it("a quick report is ready when the start answers: 201, then the PDF downloads as an attachment", async () => {
    const res = await start("readOnly", "look-ahead");
    expect(res.status).toBe(201);
    const view = res.body as ReportJobView;
    expect(view).toMatchObject({ report: "look-ahead", status: "ready", error: null });
    expect(view.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await poll("readOnly", view.id)).body).toEqual(view);
    const file = await pdf("readOnly", view.id);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toBe('attachment; filename="LookAhead.pdf"');
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect((file.body as Buffer).toString("latin1")).toBe("%PDF-sample Look Ahead");
  });

  it("each report builds its own document from the list's query", async () => {
    for (const [report, title] of [["30-60-90", "30 / 60 / 90 Report"], ["planning", "Planning Report"], ["exec-look-ahead", "Exec Look Ahead"]] as const) {
      const res = await start("hqAdmin", report);
      expect(res.status, report).toBe(201);
      expect(fake.docs.at(-1)!.title).toBe(title);
    }
  });

  it("a slow report answers 202 and is polled until ready; its PDF before then is 409", async () => {
    fake.hold();
    const res = await start("editor", "planning");
    expect(res.status).toBe(202);
    const { id } = res.body as ReportJobView;
    expect((await poll("editor", id)).body).toMatchObject({ status: "running" });
    expect((await pdf("editor", id)).status).toBe(409);
    fake.release();
    await jobs.settle(w.as.editor.id, id, 1000);
    expect((await poll("editor", id)).body).toMatchObject({ status: "ready" });
    expect((await pdf("editor", id)).status).toBe(200);
  });

  it("another user's report, a made-up id, and a malformed one are all the same 404", async () => {
    const { id } = (await start("editor", "look-ahead")).body as ReportJobView;
    for (const [who, path] of [["financeEditor", id], ["hqAdmin", id], ["editor", "AAAAAAAAAAAAAAAAAAAAAA"], ["editor", "..%2F..%2Fsecret"]] as const) {
      const a = await poll(who, path);
      expect([a.status, a.body], `${who} ${path}`).toEqual([404, { error: "not found" }]);
      expect((await pdf(who, path)).status).toBe(404);
    }
  });

  it("the Exec Look Ahead is for HQ Administrators and above only (spec addendum §6)", async () => {
    for (const who of ["readOnly", "admin", "hqEditor", "hqAdvanced"] as const) expect((await start(who, "exec-look-ahead")).status, who).toBe(403);
    expect((await start("hqAdmin", "exec-look-ahead")).status).toBe(201);
    const cfg = async (who: Who) => (await call(app, "get", "/api/config", w.as[who].cookie)).body.list.execLookAhead as boolean;
    expect([await cfg("admin"), await cfg("hqAdvanced"), await cfg("hqAdmin")]).toEqual([false, false, true]);
  });

  it("an unknown report is 404, and a bad query 400, never a 500", async () => {
    expect((await start("editor", "word")).status).toBe(404);
    expect((await call(app, "post", "/api/reports/look-ahead", w.as.editor.cookie, {})).status).toBe(400);
    expect((await start("editor", "look-ahead", { filter: { from: "2046-02-30" } })).status).toBe(400);
    expect((await start("editor", "look-ahead", { lookAhead: "look_ahead_only" })).status).toBe(403);
  });

  it(`at most ${REPORT_PER_USER_MAX} unfinished reports per user and ${REPORT_QUEUE_MAX} waiting in all; past either, 503 with Retry-After`, async () => {
    fake.hold();
    expect((await start("editor", "look-ahead")).status).toBe(202);
    expect((await start("editor", "look-ahead")).status).toBe(202);
    const mine = await start("editor", "look-ahead");
    expect(mine.status).toBe(503);
    expect(mine.headers["retry-after"]).toBe("10");
    // The editor's first is rendering, the second waits; four more can wait.
    for (const who of ["readOnly", "readOnly", "admin"] as const) expect((await start(who, "planning")).status).toBe(202);
    expect((await start("advanced", "planning")).status).toBe(503);
    fake.release();
  });

  it("a render that fails says why, and logs only a label and the route", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failWith(new ReportRenderError("out_of_memory"));
    const res = await start("editor", "look-ahead");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "failed", error: "The report is too large to prepare: narrow the filter and run it again." });
    expect((await pdf("editor", (res.body as ReportJobView).id)).status).toBe(409);
    expect(log).toHaveBeenCalledWith("[calendar] a report failed", "ERR_REPORT_OUT_OF_MEMORY", "POST /calendar/api/reports/look-ahead");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample routed");
  });

  it("a finished report is forgotten after its time", async () => {
    const { id } = (await start("editor", "look-ahead")).body as ReportJobView;
    clock += REPORT_TTL_MS + 1;
    expect((await poll("editor", id)).status).toBe(404);
  });

  it("too many rows to print is 422 before anything renders", async () => {
    // 90 activities each In the News on all 60 days: 5,400 rows.
    for (let i = 0; i < 90; i++) {
      const id = await insertRaw(tdb.db, { title: `Sample long ${i}`, startAt: new Date("2047-05-01T16:00:00Z"), endAt: new Date("2047-06-29T17:00:00Z") });
      await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    }
    const before = fake.docs.length;
    const res = await start("editor", "look-ahead", { filter: { from: "2047-05-01" } });
    expect([res.status, res.body]).toEqual([422, { error: "Too many rows to print: narrow the filter and run the report again" }]);
    expect(fake.docs.length).toBe(before);
  });

  it("with no renderer, the report routes say so: 503", async () => {
    const bare = createTestApp(tdb.db);
    expect((await call(bare, "post", "/api/reports/look-ahead", w.as.editor.cookie, { q: MARCH })).status).toBe(503);
  });
  it("a staff session only: a bearer token gets nothing, and a start without the CSRF header is refused", async () => {
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS, rules: TEST_RULES, reports: { jobs, inlineWaitMs: 200 } });
    const token = await mintLocalToken({ secret: local, subject: w.as.hqAdmin.id, roles: ["Calendar.SysAdmin"] });
    const before = fake.docs.length;
    expect((await request(withLocal).post("/api/reports/look-ahead").set("authorization", `Bearer ${token}`).set("x-gcpe-request", "1").send({ q: MARCH })).status).toBe(403);
    const { id } = (await start("hqAdmin", "look-ahead")).body as ReportJobView;
    expect((await request(withLocal).get(`/api/reports/jobs/${id}`).set("authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(withLocal).get(`/api/reports/jobs/${id}/pdf`).set("authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).post("/api/reports/look-ahead").set("cookie", w.as.hqAdmin.cookie).send({ q: MARCH })).status).toBe(403);
    expect(fake.docs.length).toBe(before + 1);
  });

  it("a role taken away after the start takes the download with it", async () => {
    const id450 = "00000000-0000-4000-8000-000000000450";
    const person = { id: id450, email: "demoted@example.test", displayName: "Sample Demoted", isActive: true, organizationKeys: ["gcpe-hq"] };
    await projectUser(app, { ...person, calendarRole: "Calendar.Administrator" });
    const cookie = await sessionCookie(id450);
    const res = await call(app, "post", "/api/reports/exec-look-ahead", cookie, { q: MARCH });
    expect(res.status).toBe(201);
    const { id } = res.body as ReportJobView;
    await projectUser(app, { ...person, calendarRole: "Calendar.Advanced" });
    const file = await request(app).get(`/api/reports/jobs/${id}/pdf`).set("cookie", cookie);
    expect([file.status, file.body]).toEqual([404, { error: "not found" }]);
    await projectUser(app, { ...person, calendarRole: null });
    expect((await request(app).get(`/api/reports/jobs/${id}/pdf`).set("cookie", cookie)).status).toBe(403);
  });
});
