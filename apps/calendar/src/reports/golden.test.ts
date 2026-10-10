import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { outlineOf, pdfPages, type PdfPage } from "../../test/pdf-text";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { activityCategories, activityCommMaterials } from "../db/schema";
import { ReportJobs } from "./jobs";
import { reportAssets } from "./render/assets";
import { workerRenderer } from "./render/renderer";

/** Supertest's body parser, for a binary body. */
type BodyParser = Parameters<ReturnType<ReturnType<typeof request>["get"]>["parse"]>[0];
const binary: BodyParser = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

// Monday 2046-03-12 to Wednesday 2046-03-14; BC is UTC−7, so 09:00 BC is 16:00Z.
const RANGE = { filter: { from: "2046-03-12", to: "2046-03-14" } };
const IDS = { A: 30001, B: 30002, C: 30003, D: 30004, E: 30005, F: 30006, G: 30007 } as const;
type Key = keyof typeof IDS;
const id = (k: Key) => `id:${IDS[k]}`;

/**
 * The parity proof (spec addendum §3 row 5g, §16 acceptance 10): each report rendered to PDF in the
 * worker, its text read back with a PDF reader, and its sections and activity order compared with
 * what legacy's rules give for this fixture. Fictional data only.
 */
describe("the reports as PDF: sections and activity order from the text (golden structure)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let jobs: ReportJobs;
  const pdfOf = async (who: Who, report: string): Promise<PdfPage[]> => {
    const started = await call(app, "post", `/api/reports/${report}`, w.as[who].cookie, { q: RANGE });
    expect(started.status, `${report} as ${who}`).toBe(201);
    const file = await request(app).get(`/api/reports/jobs/${(started.body as ReportJobView).id}/pdf`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);
    expect(file.status).toBe(200);
    return pdfPages(new Uint8Array(file.body as Buffer));
  };
  const text = (pages: PdfPage[]) => pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    jobs = new ReportJobs({ renderer: workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000 }), concurrency: 1 });
    app = createTestApp(tdb.db, { reports: { jobs, inlineWaitMs: 30_000 } });
    w = await seedWorld(app, tdb.db);
    const make = async (k: Key, start: string, end: string, over: Parameters<typeof insertRaw>[1], category: number = w.cat.plain) => {
      await insertRaw(tdb.db, { id: IDS[k], title: `Golden ${k}`, details: `Fictional details ${k}`, startAt: new Date(start), endAt: new Date(end), ...over });
      await tdb.db.insert(activityCategories).values({ activityId: IDS[k], categoryId: category });
    };
    await make("A", "2046-03-12T16:00:00Z", "2046-03-12T17:00:00Z", { hqSection: "events_and_speeches" });
    await tdb.db.insert(activityCommMaterials).values({ activityId: IDS.A, commMaterialId: w.commMaterial.newsRelease });
    await make("B", "2046-03-12T17:00:00Z", "2046-03-12T18:00:00Z", { hqSection: "events_and_speeches", isConfidential: true });
    await make("C", "2046-03-13T16:00:00Z", "2046-03-13T17:00:00Z", { hqSection: "in_the_news", contactMinistryKey: "finance" });
    await make("D", "2046-03-13T17:00:00Z", "2046-03-13T18:00:00Z", { hqSection: "issues_and_reports", contactMinistryKey: "finance", isConfidential: true });
    await make("E", "2046-03-14T07:00:00Z", "2046-03-15T06:45:00Z", { hqSection: "not_on_la", isAllDay: true }, w.cat.awareness);
    await make("F", "2046-03-12T18:00:00Z", "2046-03-12T19:00:00Z", { hqSection: "not_on_la", contactMinistryKey: "consult" });
    await make("G", "2046-03-12T16:00:00Z", "2046-03-18T16:00:00Z", { hqSection: "in_the_news", isIssue: true, isConfirmed: false });
  });
  afterAll(async () => {
    await jobs.close();
    await tdb.drop();
  });

  it("Look Ahead, Health Editor: their events, an empty day said so, Issues by the ministry rule, Awareness; no Consultations section", async () => {
    const pages = await pdfOf("editor", "look-ahead");
    expect(pages.every((p) => p.size[0] === 612 && p.size[1] === 792)).toBe(true);
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"), id("B"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ ISSUES AND REPORTS", id("G"),
      "§ OUTSIDE GOVERNMENT",
      "§ AWARENESS DATES", id("E"),
    ]);
    const all = text(pages);
    expect(all).toContain("DRAFT ONLY - NOT FOR CIRCULATION");
    expect(all).toContain("Monday, Mar. 12, 2046 to Wednesday, Mar. 14, 2046");
    expect(all).not.toContain("Consultations and Dialogues");
    expect(all).toContain("Not for Look Ahead Fictional details B");
    for (const k of ["C", "D", "F"] as const) expect(all).not.toContain(`Golden ${k}`);
  });

  it("Look Ahead, HQ Administrator: Issues by section, In the News per day, a page per day", async () => {
    const pages = await pdfOf("hqAdmin", "look-ahead");
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"), id("B"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ ISSUES AND REPORTS", id("D"),
      "§ OUTSIDE GOVERNMENT",
      "§ IN THE NEWS", id("G"), "§ IN THE NEWS", id("C"), id("G"), "§ IN THE NEWS", id("G"),
      "§ AWARENESS DATES", id("E"),
    ]);
    // Cover, then one page for each of the three days (HQ breaks after every day but Saturday), Issues, In the News, Awareness.
    expect(pages).toHaveLength(7);
    expect(text(pages)).not.toContain("Golden F");
  });

  it("Look Ahead, HQ Editor: another ministry's confidential activities nowhere (C127)", async () => {
    const pages = await pdfOf("hqEditor", "look-ahead");
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ OUTSIDE GOVERNMENT",
      "§ IN THE NEWS", id("G"), "§ IN THE NEWS", id("C"), id("G"), "§ IN THE NEWS", id("G"),
      "§ AWARENESS DATES", id("E"),
    ]);
    for (const k of ["B", "D"] as const) expect(text(pages)).not.toContain(`Golden ${k}`);
  });

  it("Exec Look Ahead, HQ Administrator: the Look Ahead's structure with each row's Last updated", async () => {
    const pages = await pdfOf("hqAdmin", "exec-look-ahead");
    expect(outlineOf(pages)).toEqual(outlineOf(await pdfOf("hqAdmin", "look-ahead")));
    expect(text(pages)).toMatch(/Last updated/);
    expect(text(pages)).not.toMatch(/Last updated updated/);
  });

  it("30/60/90, Health Editor: one month, each activity once, the consultations ministry kept", async () => {
    const pages = await pdfOf("editor", "30-60-90");
    expect(outlineOf(pages)).toEqual(["§ 30 / 60 / 90 REPORT", "# March 2046", id("A"), id("B"), id("G"), id("E")]);
    expect(text(pages)).toMatch(/DRAFT AND CONFIDENTIAL Updated Tuesday, Nov 3, 2026 11:00 AM/);
  });

  it("Planning, HQ Administrator: Legal landscape, every visible activity in legacy's order", async () => {
    const pages = await pdfOf("hqAdmin", "planning");
    expect(pages.every((p) => p.size[0] === 1008 && p.size[1] === 612)).toBe(true);
    expect(outlineOf(pages)).toEqual(["A", "B", "F", "G", "C", "D", "E"].map((k) => id(k as Key)));
    expect(text(pages)).toContain("Sample Corporate Calendar: Schedule of Activities");
  });
});
