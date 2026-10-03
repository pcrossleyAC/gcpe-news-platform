import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, ReleaseAlreadyPublishedError, ReleaseExistsError, ReleaseNotFoundError, releaseDraftSchema, scheduleRelease } from "./releases";

describe("NRMS releases", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNrmsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE releases"); });

  it("creates a draft and rejects the same key in another casing", async () => {
    await createDraft(tdb.db, sampleDraft);
    expect((await getRelease(tdb.db, sampleDraft.key))?.status).toBe("draft");
    await expect(createDraft(tdb.db, { ...sampleDraft, key: sampleDraft.key.toLowerCase() })).rejects.toBeInstanceOf(ReleaseExistsError);
  });

  it("looks releases up case-insensitively", async () => {
    await createDraft(tdb.db, sampleDraft);
    expect((await getRelease(tdb.db, sampleDraft.key.toLowerCase()))?.key).toBe(sampleDraft.key);
  });

  it("schedules a draft and refuses to reschedule a published release", async () => {
    await createDraft(tdb.db, sampleDraft);
    const at = new Date("2026-10-03T17:00:00Z");
    await scheduleRelease(tdb.db, sampleDraft.key, at);
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "scheduled", publishAt: at });
    await tdb.pool.query("UPDATE releases SET status = 'published'");
    await expect(scheduleRelease(tdb.db, sampleDraft.key, at)).rejects.toBeInstanceOf(ReleaseAlreadyPublishedError);
    await expect(scheduleRelease(tdb.db, "nope", at)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it("validates keys: letters, digits and hyphens only", () => {
    expect(releaseDraftSchema.safeParse({ ...sampleDraft, key: "../x" }).success).toBe(false);
    expect(releaseDraftSchema.safeParse({ ...sampleDraft, key: "a b" }).success).toBe(false);
    expect(releaseDraftSchema.safeParse(sampleDraft).success).toBe(true);
  });
});
