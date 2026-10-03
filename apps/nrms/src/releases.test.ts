import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, ReleaseAlreadyPublishedError, ReleaseExistsError, ReleaseNotFoundError, ReleaseTooLargeError, releaseDraftSchema, scheduleRelease } from "./releases";

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

  it("rejects a draft whose published event would exceed MAX_EVENT_BYTES", async () => {
    const draft = {
      ...sampleDraft,
      key: "TOO-BIG-1",
      documents: [{ ...sampleDraft.documents[0]!, detailsHtml: "x".repeat(1_100_000) }],
    };
    await expect(createDraft(tdb.db, draft)).rejects.toBeInstanceOf(ReleaseTooLargeError);
    expect(await getRelease(tdb.db, draft.key)).toBeUndefined();
  });

  it("rejects scheduling with an invalid Date, even before checking whether the release exists", async () => {
    // A nonexistent key would otherwise resolve to ReleaseNotFoundError first; asserting
    // RangeError here proves the Date is validated up front, not left to whatever the pg
    // driver happens to do while serializing a bad timestamp parameter.
    await expect(scheduleRelease(tdb.db, "does-not-exist", new Date("not-a-date"))).rejects.toBeInstanceOf(RangeError);
  });

  it("reschedules a failed release back to scheduled and clears last_error", async () => {
    await createDraft(tdb.db, sampleDraft);
    await tdb.pool.query("UPDATE releases SET status = 'failed', last_error = 'boom'");
    const at = new Date("2026-10-03T17:00:00Z");
    await scheduleRelease(tdb.db, sampleDraft.key, at);
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "scheduled", publishAt: at, lastError: null });
  });
});
