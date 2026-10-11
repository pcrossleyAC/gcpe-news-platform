import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged } from "@gcpe/events";
import { createCalendarTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../test/world";
import { activityCategories, releaseLinks } from "./db/schema";

const RELEASE = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01";
const OTHER_RELEASE = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a02";

describe("the Calendar's release projection (spec addendum §11): release.status_changed → BC Gov News", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let w: World;
  let a: number;
  let b: number;
  const change = (over: Partial<ReleaseStatusChanged> = {}): ReleaseStatusChanged => ({
    releaseId: RELEASE, key: null, reference: null, type: "release", activityId: a, previousActivityId: null,
    status: "draft", publishAt: "2031-06-11T17:00:00.000Z", releasedAt: null, headline: "Sample headline", ...over,
  });
  /** Sends one event from NRMS; returns the receiver's outcome. */
  const send = async (data: ReleaseStatusChanged, sequence?: number, source = "nrms") => {
    const e = envelope(source, "release.status_changed", data, `release:${data.releaseId}`);
    const res = await sendEvent(app, sequence === undefined ? e : { ...e, sequence });
    expect(res.status).toBe(200);
    return res.body.outcome as string;
  };
  const releasesOn = async (id: number) => (await call(app, "get", `/api/activities/${id}`, w.as.hqAdmin.cookie)).body.releases as { releaseId: string; status: string; reference: string | null }[];
  const links = () => tdb.db.select().from(releaseLinks);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    a = await insertRaw(tdb.db, { title: "Sample activity A" });
    b = await insertRaw(tdb.db, { title: "Sample activity B" });
  });
  afterAll(() => tdb.drop());

  it("a linked release shows on its activity, and each later status replaces the last", async () => {
    expect(await send(change())).toBe("applied");
    expect(await releasesOn(a)).toEqual([{ releaseId: RELEASE, type: "release", status: "draft", reference: null, publishAt: "2031-06-11T17:00:00.000Z", releasedAt: null }]);
    await send(change({ status: "published", reference: "NEWS-00001", key: "2031HLTH0001-000001", releasedAt: "2031-06-11T17:00:00.000Z" }));
    expect(await releasesOn(a)).toEqual([expect.objectContaining({ status: "published", reference: "NEWS-00001", releasedAt: "2031-06-11T17:00:00.000Z" })]);
    expect((await links())[0]).toMatchObject({ key: "2031HLTH0001-000001", headline: "Sample headline" });
  });

  it("the list's release icon follows it", async () => {
    await tdb.db.insert(activityCategories).values({ activityId: a, categoryId: w.cat.plain });
    const q = encodeURIComponent(JSON.stringify({ filter: { from: "2026-11-01", to: "2026-11-30", quickSearch: "Sample activity A" } }));
    const res = await call(app, "get", `/api/list?q=${q}`, w.as.hqAdmin.cookie);
    expect(res.body.rows.find((r: { id: number }) => r.id === a)).toMatchObject({ hasRelease: true });
  });

  it("an older status arriving late, or a replayed dead letter, changes nothing", async () => {
    expect(await send(change({ status: "scheduled" }), 1)).toBe("stale");
    expect((await releasesOn(a))[0]!.status).toBe("published");
  });

  it("moving the release to another activity moves it on the Calendar; clearing the link removes it", async () => {
    await send(change({ activityId: b, previousActivityId: a, status: "approved", reference: "NEWS-00001" }));
    expect(await releasesOn(a)).toEqual([]);
    expect((await releasesOn(b)).map((r) => r.releaseId)).toEqual([RELEASE]);
    await send(change({ activityId: null, previousActivityId: b }));
    expect(await releasesOn(b)).toEqual([]);
    expect(await links()).toEqual([]);
  });

  it("a deleted release leaves its activity: its row goes, and the list's icon with it (legacy showed active releases only)", async () => {
    await send(change({ releaseId: OTHER_RELEASE }));
    await send(change({ releaseId: OTHER_RELEASE, status: "deleted" }));
    expect(await releasesOn(a)).toEqual([]);
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });

  it("a release linked to an activity the Calendar doesn't hold (not imported) is ignored, and drops a link it had", async () => {
    await send(change({ releaseId: OTHER_RELEASE, status: "draft" }));
    expect(await send(change({ releaseId: OTHER_RELEASE, activityId: 999_999, previousActivityId: a }))).toBe("applied");
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });

  it("only NRMS may send it", async () => {
    expect(await send(change({ releaseId: OTHER_RELEASE }), undefined, "core")).toBe("ignored");
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });
});
