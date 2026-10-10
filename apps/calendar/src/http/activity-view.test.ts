import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { activityFiles, releaseLinks } from "../db/schema";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, seedWorld, validInput, type World } from "../../test/world";

describe("the activity view's ministry, watchers, files and release links", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const view = (who: keyof World["as"], id: number) => call(app, "get", `/api/activities/${id}`, w.as[who].cookie);
  const create = async (over = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.id as number;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("names the lead ministry's abbreviation, for MIN-Id", async () => {
    const id = await create();
    expect((await view("editor", id)).body.ministryAbbreviation).toBe("HLTH");
  });

  it("says whether the viewer watches it and who does, by name", async () => {
    const id = await create();
    expect((await view("editor", id)).body.watch).toEqual({ isWatched: false, watcherNames: [] });
    await call(app, "put", `/api/activities/${id}/watch`, w.as.admin.cookie, {});
    await call(app, "put", `/api/activities/${id}/watch`, w.as.editor.cookie, {});
    expect((await view("editor", id)).body.watch).toEqual({ isWatched: true, watcherNames: ["Robin Staff", "Sample Admin"] });
    expect((await view("readOnly", id)).body.watch).toEqual({ isWatched: false, watcherNames: ["Robin Staff", "Sample Admin"] });
  });

  it("lists its files by name, with who uploaded them", async () => {
    const id = await create();
    await tdb.db.insert(activityFiles).values([
      { activityId: id, fileName: "b-sample.pdf", contentType: "application/pdf", length: 10, sha256: "0".repeat(64), storageKey: `activities/${id}/aaaaaaaaaaaaaaaa-b-sample.pdf`, uploadedAt: FIXED_NOW, uploadedBy: w.as.editor.id },
      { activityId: id, fileName: "A-sample.txt", contentType: "text/plain", length: 4, sha256: "1".repeat(64), storageKey: `activities/${id}/bbbbbbbbbbbbbbbb-a-sample.txt`, uploadedAt: FIXED_NOW, uploadedBy: null },
    ]);
    const files = (await view("readOnly", id)).body.files;
    expect(files.map((f: { fileName: string }) => f.fileName)).toEqual(["A-sample.txt", "b-sample.pdf"]);
    expect(files[1]).toMatchObject({ contentType: "application/pdf", length: 10, uploadedAt: FIXED_NOW.toISOString(), uploadedByName: "Robin Staff" });
    expect(files[0].uploadedByName).toBeNull();
    expect(files[0]).not.toHaveProperty("storageKey");
    expect(files[0]).not.toHaveProperty("sha256");
  });

  it("lists its release links without deleted releases, and without headlines", async () => {
    const id = await create();
    await tdb.db.insert(releaseLinks).values([
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", activityId: id, key: null, type: "release", status: "scheduled", publishAt: new Date("2026-11-12T17:00:00Z"), releasedAt: null, reference: "NEWS-00001", headline: "Sample headline", lastSequence: 1 },
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a02", activityId: id, key: null, type: "advisory", status: "deleted", publishAt: null, releasedAt: null, reference: null, headline: "Sample gone", lastSequence: 1 },
    ]);
    expect((await view("editor", id)).body.releases).toEqual([
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", type: "release", status: "scheduled", reference: "NEWS-00001", publishAt: "2026-11-12T17:00:00.000Z", releasedAt: null },
    ]);
  });

  it("labels file history as Records on View changes", async () => {
    const { HISTORY_FIELDS } = await import("@gcpe/calendar-contract");
    expect(HISTORY_FIELDS.files).toBe("Records");
  });
});
