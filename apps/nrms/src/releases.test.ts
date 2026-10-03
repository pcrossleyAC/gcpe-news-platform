import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { envelopeByteLength, MAX_EVENT_BYTES, sizingEnvelope } from "@gcpe/events";
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

  // P2-R22 D2: size against the largest sequence the release.published event could carry, not
  // sequence 1 — a draft that only fits with a 1-digit sequence would otherwise be accepted
  // here and then fail enqueueEvent's own check at publish time.
  it("sizes the draft's event at the maximum sequence width, rejecting one that only fits at sequence 1", async () => {
    const placeholder = new Date(0).toISOString();
    const recordFor = (detailsHtml: string) => {
      const { key, kind, ...content } = { ...sampleDraft, key: "EDGE-1", documents: [{ ...sampleDraft.documents[0]!, detailsHtml }] };
      return { ...content, key, kind, publishDate: placeholder, timestamp: placeholder, atomId: null, renditions: null };
    };
    const envelopeAtSequence1 = (detailsHtml: string) => ({ ...sizingEnvelope({ type: "release.published", source: "nrms", aggregateId: "EDGE-1", data: recordFor(detailsHtml) }), sequence: 1 });
    const padding = MAX_EVENT_BYTES - envelopeByteLength(envelopeAtSequence1(""));
    expect(envelopeByteLength(envelopeAtSequence1("x".repeat(padding)))).toBe(MAX_EVENT_BYTES); // fits at sequence 1...

    const draft = { ...sampleDraft, key: "EDGE-1", documents: [{ ...sampleDraft.documents[0]!, detailsHtml: "x".repeat(padding) }] };
    await expect(createDraft(tdb.db, draft)).rejects.toBeInstanceOf(ReleaseTooLargeError); // ...but not at a 10-digit one

    const fits = { ...draft, documents: [{ ...draft.documents[0]!, detailsHtml: "x".repeat(padding - 9) }] };
    await expect(createDraft(tdb.db, fits)).resolves.toBeUndefined();
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
