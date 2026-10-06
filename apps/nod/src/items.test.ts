import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "./app";
import { createNodTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { items, sendJobs } from "./db/schema";

describe("items from NRMS release events", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createTestApp(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items CASCADE");
  });

  it("published creates the item from the release", async () => {
    const r = { ...sampleRelease, key: "K-ITEM", kind: "releases" as const };
    expect((await sendEvent(app, envelope("nrms", "release.published", r, r.key))).status).toBe(200);
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-ITEM"));
    expect(row).toMatchObject({ kind: "release", postKind: "releases", url: "https://news.example/site/releases/K-ITEM", toSubscribers: r.publishFlags.toSubscribers });
    expect(row!.listKeys).toEqual(indexKeysFor(r));
  });

  it("updated never sends and never creates; it refreshes an existing item", async () => {
    const r = { ...sampleRelease, key: "K-UPD" };
    await sendEvent(app, envelope("nrms", "release.updated", { ...r, notify: true }, r.key));
    expect(await tdb.db.select().from(items).where(eq(items.key, "K-UPD"))).toHaveLength(0);
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const jobsBefore = await tdb.db.select().from(sendJobs);
    const corrected = { ...r, documents: r.documents.map((d) => ({ ...d, headline: "Corrected headline" })), notify: true };
    await sendEvent(app, envelope("nrms", "release.updated", corrected, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-UPD"));
    expect(row!.title).toBe("Corrected headline");
    expect(await tdb.db.select().from(sendJobs)).toHaveLength(jobsBefore.length);
  });

  it("unpublished withdraws the item and cancels its pending jobs", async () => {
    const r = { ...sampleRelease, key: "K-WD" };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    await tdb.db.insert(sendJobs).values({ jobKey: "as_it_happens:K-WD", itemKey: "K-WD", kind: "as_it_happens", subject: "s" }).onConflictDoNothing();
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-WD" }, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-WD"));
    expect(row!.withdrawnAt).not.toBeNull();
    const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-WD"));
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
  });

  // A release republished after being withdrawn must not stay marked withdrawn.
  it("republishing a withdrawn item clears withdrawn_at", async () => {
    const r = { ...sampleRelease, key: "K-REPUB" };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-REPUB" }, r.key));
    const [withdrawn] = await tdb.db.select().from(items).where(eq(items.key, "K-REPUB"));
    expect(withdrawn!.withdrawnAt).not.toBeNull();

    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [republished] = await tdb.db.select().from(items).where(eq(items.key, "K-REPUB"));
    expect(republished!.withdrawnAt).toBeNull();
  });

  // Title/summary fallback chain (from the real legacy digest sample): English headline/
  // subheadline when present, else the first document's headline, else the key for title,
  // and r.summary for summary when there's no English subheadline.
  it("falls back to the first document's headline, and to r.summary, when there is no English document", async () => {
    const r = {
      ...sampleRelease,
      key: "K-NOENGLISH",
      summary: "Fallback summary from r.summary.",
      documents: [{ ...sampleRelease.documents[0]!, languageId: 1036, headline: "Titre francais", subheadline: "" }],
    };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-NOENGLISH"));
    expect(row!.title).toBe("Titre francais");
    expect(row!.summary).toBe("Fallback summary from r.summary.");
  });

  it("falls back to the release key when there are no documents at all", async () => {
    const r = { ...sampleRelease, key: "K-NODOCS", documents: [] };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-NODOCS"));
    expect(row!.title).toBe("K-NODOCS");
  });

  it("uses the English document's subheadline as the summary when it's non-empty", async () => {
    const r = {
      ...sampleRelease,
      key: "K-SUBHEAD",
      summary: "This should be ignored in favour of the subheadline.",
      documents: [{ ...sampleRelease.documents[0]!, languageId: 4105, subheadline: "The real digest-style summary line." }],
    };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-SUBHEAD"));
    expect(row!.summary).toBe("The real digest-style summary line.");
  });
});
