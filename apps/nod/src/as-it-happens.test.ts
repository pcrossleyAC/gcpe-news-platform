import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb, envelope } from "../test/helpers";
import { deliveries, sendJobs, subscribers } from "./db/schema";
import { addSubscriber } from "./subscribers";
import { createAsItHappensHandler, renderAsItHappens } from "./as-it-happens";

const PUBLIC_SITE_URL = "https://news.gov.bc.ca";
const MANAGE_URL = "https://news.gov.bc.ca/manage";

describe("createAsItHappensHandler", () => {
  let tdb: TestDatabase;
  let handler: ReturnType<typeof createAsItHappensHandler>;
  let a: string; // all news, verified
  let b: string; // ministries:health, verified
  let c: string; // sectors:mining, verified
  let d: string; // all news, unverified

  beforeAll(async () => {
    tdb = await createNodTestDb();
    handler = createAsItHappensHandler({ publicSiteUrl: PUBLIC_SITE_URL, manageUrl: MANAGE_URL });

    a = (await addSubscriber(tdb.db, { email: "a.all@example.com", lists: "all" })).id;
    b = (await addSubscriber(tdb.db, { email: "b.health@example.com", lists: ["ministries:Health"] })).id;
    c = (await addSubscriber(tdb.db, { email: "c.mining@example.com", lists: ["sectors:Mining"] })).id;
    d = (await addSubscriber(tdb.db, { email: "d.all.unverified@example.com", lists: "all" })).id;
    await tdb.db.update(subscribers).set({ verifiedAt: null }).where(eq(subscribers.id, d));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs");
  });

  const releaseEvent = (release = sampleRelease) => envelope("nrms", "release.published", release, release.key);

  it("delivers to subscribers matching '*' or the release's index keys (case-insensitively), and creates one send job", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows.map((r) => r.subscriberId).sort()).toEqual([a, b].sort());

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]!.subject).toBe(release.documents[0]!.headline);
    expect(jobRows[0]!.kind).toBe("as_it_happens");
  });

  it("is idempotent: applying the same release again adds no new deliveries and no new send job", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows).toHaveLength(2);

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(1);
  });

  it("does nothing when publishFlags.toSubscribers is false", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: false } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows).toHaveLength(0);
    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(0);
  });

});

describe("createAsItHappensHandler with no subscribers at all", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates no deliveries and no send job when no subscriber matches (an empty job would send nothing)", async () => {
    const handler = createAsItHappensHandler({ publicSiteUrl: PUBLIC_SITE_URL, manageUrl: MANAGE_URL });
    const release = { ...sampleRelease, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, envelope("nrms", "release.published", release, release.key)));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows).toHaveLength(0);
    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(0);
  });
});

describe("renderAsItHappens", () => {
  it("escapes '<script>' in the headline and neutralises '{{manageUrl}}' inside release text, keeping exactly one real placeholder in the footer", () => {
    const release = {
      ...sampleRelease,
      summary: "Contains {{manageUrl}} right here.",
      documents: [{ ...sampleRelease.documents[0]!, headline: "<script>alert(1)</script> and {{manageUrl}}" }],
    };
    const { html, text } = renderAsItHappens(release, "https://news.gov.bc.ca");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // Exactly one real, matchable {{manageUrl}} placeholder: the footer link.
    expect(html.match(/\{\{manageUrl\}\}/g)).toEqual(["{{manageUrl}}"]);
    expect(html).toContain('<a href="{{manageUrl}}">Manage or unsubscribe</a>');
    // The headline/summary's own "{{manageUrl}}" text is neutralised, not a live placeholder.
    expect(html).toContain("{&#123;manageUrl}}");

    expect(text.match(/\{\{manageUrl\}\}/g)).toEqual(["{{manageUrl}}"]);
    expect(text).toContain("{ {manageUrl}}");
  });

  it("falls back to the release key when there is no English headline", () => {
    const release = { ...sampleRelease, key: "NO-HEADLINE-1", documents: [] };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject).toBe("NO-HEADLINE-1");
  });
});
