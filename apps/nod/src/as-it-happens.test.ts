import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb, envelope } from "../test/helpers";
import { deliveries, sendJobs, subscribers, subscriptions } from "./db/schema";
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
  let e: string; // BOTH '*' and ministries:health, verified — must still get exactly one delivery
  let f: string; // all news, verified, but as_it_happens=false on its subscription (R6)

  beforeAll(async () => {
    tdb = await createNodTestDb();
    handler = createAsItHappensHandler({ publicSiteUrl: PUBLIC_SITE_URL, manageUrl: MANAGE_URL });

    a = (await addSubscriber(tdb.db, { email: "a.all@example.com", lists: "all" })).id;
    b = (await addSubscriber(tdb.db, { email: "b.health@example.com", lists: ["ministries:Health"] })).id;
    c = (await addSubscriber(tdb.db, { email: "c.mining@example.com", lists: ["sectors:Mining"] })).id;
    d = (await addSubscriber(tdb.db, { email: "d.all.unverified@example.com", lists: "all" })).id;
    e = (await addSubscriber(tdb.db, { email: "e.all-and-health@example.com", lists: ["*", "ministries:Health"] })).id;
    f = (await addSubscriber(tdb.db, { email: "f.all.digest-only@example.com", lists: "all" })).id;
    await tdb.db.update(subscribers).set({ verifiedAt: null }).where(eq(subscribers.id, d));
    // addSubscriber (the public API) always creates a subscription with as_it_happens=true;
    // flipping it directly here is the only way to get a digest-only subscription into a
    // fixture today (R6) — there's no HTTP/service path yet that sets it to false.
    await tdb.db.update(subscriptions).set({ asItHappens: false }).where(eq(subscriptions.subscriberId, f));
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
    expect(deliveryRows.map((r) => r.subscriberId).sort()).toEqual([a, b, e].sort());

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]!.subject).toBe(release.documents[0]!.headline);
    expect(jobRows[0]!.kind).toBe("as_it_happens");
  });

  it("a subscriber on two matching lists ('*' and 'ministries:health') still gets exactly one delivery", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const eDeliveries = await tdb.db.select().from(deliveries).where(and(eq(deliveries.releaseKey, release.key), eq(deliveries.subscriberId, e)));
    expect(eDeliveries).toHaveLength(1);

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(1);
  });

  it("is idempotent: applying the same release again adds no new deliveries and no new send job", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows).toHaveLength(3);

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

  // R6: a verified subscriber on a matching list ('*') whose *subscription* has
  // as_it_happens=false (a digest-only subscriber) must never get an as-it-happens delivery,
  // even though every other condition matches.
  it("excludes a verified, list-matching subscriber whose subscription has as_it_happens=false", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => handler(tx, releaseEvent(release)));

    const fDeliveries = await tdb.db.select().from(deliveries).where(and(eq(deliveries.releaseKey, release.key), eq(deliveries.subscriberId, f)));
    expect(fDeliveries).toHaveLength(0);

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, release.key));
    expect(deliveryRows.map((r) => r.subscriberId)).not.toContain(f);
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

  // I4: a raw headline with embedded CR/LF/tabs or a real "{{manageUrl}}" would otherwise be
  // sent to Distribution verbatim as the subject — Distribution 400s on line breaks (terminal,
  // nobody mailed) and would substitute the headline's own placeholder.
  it("collapses CR/LF/tabs in the subject to single spaces, trims, and neutralises '{{'", () => {
    const release = {
      ...sampleRelease,
      documents: [{ ...sampleRelease.documents[0]!, headline: "  Highway 11\r\nclosure\tand {{manageUrl}} update  " }],
    };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject).toBe("Highway 11 closure and { {manageUrl}} update");
    expect(subject).not.toMatch(/[\r\n\t]/);
  });

  it("truncates a subject over 998 UTF-16 units, ending in '…'", () => {
    const longHeadline = "x".repeat(1200);
    const release = { ...sampleRelease, documents: [{ ...sampleRelease.documents[0]!, headline: longHeadline }] };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject.length).toBe(998);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.slice(0, 997)).toBe("x".repeat(997));
  });

  // R2: Distribution's own max(998) is `z.string().max(998)`, which counts UTF-16 *code
  // units* — the previous (reverted) code-point-based truncation let a 600-emoji headline
  // (600 code points, but 1200 UTF-16 units — astral emoji are surrogate pairs) straight
  // through unmodified, well over the real limit. Also proves no lone surrogate is left
  // dangling at the cut point.
  it("truncates a subject measured in UTF-16 units, not code points, without splitting a surrogate pair (600 emoji)", () => {
    const longHeadline = "😀".repeat(600); // 600 code points, 1200 UTF-16 units
    const release = { ...sampleRelease, documents: [{ ...sampleRelease.documents[0]!, headline: longHeadline }] };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject.length).toBeLessThanOrEqual(998);
    expect(subject.endsWith("…")).toBe(true);
    const withoutEllipsis = subject.slice(0, -1);
    // An even number of units and every code point a complete "😀" proves no dangling half
    // of a surrogate pair was left in.
    expect(withoutEllipsis.length % 2).toBe(0);
    expect([...withoutEllipsis].every((ch) => ch === "😀")).toBe(true);
  });

  it("leaves a short, already-clean subject untouched (no truncation marker)", () => {
    const release = { ...sampleRelease, documents: [{ ...sampleRelease.documents[0]!, headline: "Short clean headline" }] };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject).toBe("Short clean headline");
  });

  // R2: a headline that's present but whitespace-only must not produce an empty subject
  // (Distribution's schema requires at least 1 character) — falls back to the release key,
  // same as a genuinely missing headline.
  it("falls back to the release key when the headline is whitespace-only", () => {
    const release = { ...sampleRelease, key: "WHITESPACE-ONLY-1", documents: [{ ...sampleRelease.documents[0]!, headline: "   \t\n  " }] };
    const { subject } = renderAsItHappens(release, "https://news.gov.bc.ca");
    expect(subject).toBe("WHITESPACE-ONLY-1");
  });
});

describe("createAsItHappensHandler at scale (I1)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  // I1: the old implementation sent matched subscriber ids as JS-side bind params, 2 per row —
  // past ~32,767 matched subscribers that blows Postgres's 65,535 bind-parameter limit and the
  // whole insert throws (0 deliveries, the event effectively dead). 33,000 subscribers,
  // inserted server-side via a single INSERT...SELECT...FROM generate_series (not one
  // JS round-trip per row) so the test itself stays fast, proves the fix handles it.
  it("delivers to more than 32,767 matching subscribers without hitting Postgres's bind-parameter limit", async () => {
    await tdb.pool.query(`
      INSERT INTO subscribers (email, manage_token, verified_at)
      SELECT 'bulk' || gs || '@example.com', 'bulk-token-' || gs, now()
        FROM generate_series(1, 33000) AS gs
    `);
    await tdb.pool.query(`
      INSERT INTO subscriptions (subscriber_id, list_key)
      SELECT id, '*' FROM subscribers WHERE email LIKE 'bulk%@example.com'
    `);

    const handler = createAsItHappensHandler({ publicSiteUrl: PUBLIC_SITE_URL, manageUrl: MANAGE_URL });
    const release = { ...sampleRelease, key: "BULK-RELEASE-1", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };

    await tdb.db.transaction((tx) => handler(tx, envelope("nrms", "release.published", release, release.key)));

    const rows = (await tdb.pool.query(`SELECT count(*)::int FROM deliveries WHERE release_key = $1`, [release.key])).rows as { count: number }[];
    expect(rows[0]!.count).toBe(33000);

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, release.key));
    expect(jobRows).toHaveLength(1);
  }, 10_000);
});
