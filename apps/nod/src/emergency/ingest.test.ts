import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { renderFeedXml, type FakeAlert } from "@gcpe/emergency-feed-fake";
import { createNodTestDb } from "../../test/helpers";
import { createItemSending, emergencyItemKey, type ItemSending } from "../as-it-happens";
import { deliveries, items, nodSettings, sendJobs, subscribers, subscriptions } from "../db/schema";
import { fetchFeed, FeedFetchError, getEmergencyFeedStatus, MAX_FEED_BYTES, runEmergencyFeedIfDue } from "./ingest";

const URL_A = "https://emergency.example.test/feed.xml";
const render = { siteUrl: "https://news.example.test", bannerUrl: null };
const alert = (n: number, over: Partial<FakeAlert> = {}): FakeAlert => ({
  guid: `g-${n}`,
  link: `https://emergency.example.test/alerts/${n}`,
  title: `Alert ${n}`,
  html: `<p>Body ${n}</p>`,
  publishedAt: "2026-10-06T21:15:00.000Z",
  ...over,
});
/** A fetch stand-in; each call gets a fresh Response (a body can be read only once). */
const asFetch = (f: () => Promise<Response>) => vi.fn(f) as unknown as typeof fetch;
const serving = (body: string, status = 200) => asFetch(async () => new Response(body, { status }));

describe("emergency feed ingester", () => {
  let tdb: TestDatabase;
  const sending = createItemSending({ render });
  let clock = new Date("2026-10-07T18:00:00Z");
  const now = () => clock;
  const later = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const run = (fetchImpl: typeof fetch, url: string | null = URL_A) => runEmergencyFeedIfDue({ db: tdb.db, url, items: sending, fetch: fetchImpl, now });
  const emergencyJobs = async () => (await tdb.db.select().from(sendJobs).where(like(sendJobs.jobKey, "emergency:%"))).length;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s] = await tdb.db.insert(subscribers).values({ email: "alerts@example.test", status: "active", asItHappens: false, digest: true }).returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values({ subscriberId: s!.id, listKey: "emergency:alerts" });
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    // Deliveries too: a leftover row for the same item and subscriber would make the next
    // test's send insert nothing.
    await tdb.db.delete(deliveries);
    await tdb.db.delete(sendJobs);
    await tdb.db.delete(items).where(eq(items.kind, "emergency"));
    await tdb.db.update(nodSettings).set({ emergencyFeedCheckedAt: null, emergencyFeedSeededUrl: null, emergencyFeedResult: null }).where(eq(nodSettings.id, 1));
    clock = new Date("2026-10-07T18:00:00Z");
  });

  it("no URL configured: does nothing and claims nothing", async () => {
    const f = serving(renderFeedXml([alert(1)]));
    expect(await run(f, null)).toEqual({ ran: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("the first read of a URL records its alerts and sends nothing; a later new alert sends", async () => {
    const first = await run(serving(renderFeedXml([alert(1), alert(2)])));
    expect(first.result).toMatchObject({ ok: true, seeded: true, inFeed: 2, created: 2 });
    expect(await emergencyJobs()).toBe(0);

    later(5);
    const second = await run(serving(renderFeedXml([alert(3), alert(1), alert(2)])));
    expect(second.result).toMatchObject({ ok: true, seeded: false, inFeed: 3, created: 1 });
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, emergencyItemKey("g-3")));
    expect(job).toMatchObject({ kind: "emergency", subject: "Emergency Info BC - Alert 3" });
  });

  it("changing the configured URL seeds again instead of sending everything in the new feed", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    const other = await run(serving(renderFeedXml([alert(7), alert(8)])), "https://emergency.example.test/other.xml");
    expect(other.result).toMatchObject({ seeded: true, created: 2 });
    expect(await emergencyJobs()).toBe(0);
  });

  it("runs at most once every 5 minutes", async () => {
    const f = serving(renderFeedXml([alert(1)]));
    expect((await run(f)).ran).toBe(true);
    later(4);
    expect((await run(f)).ran).toBe(false);
    later(1);
    expect((await run(f)).ran).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a new guid on a known link sends nothing", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    const r = await run(serving(renderFeedXml([alert(1, { guid: "g-1-renamed" })])));
    expect(r.result).toMatchObject({ created: 0, updated: 0 });
    expect(await emergencyJobs()).toBe(0);
  });

  it("an edited alert is updated in place, not re-sent", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    await run(serving(renderFeedXml([alert(1), alert(2)])));
    expect(await emergencyJobs()).toBe(1);
    later(5);
    const r = await run(serving(renderFeedXml([alert(2, { title: "Alert 2 (updated)", html: "<p>New text</p>" }), alert(1)])));
    expect(r.result).toMatchObject({ created: 0, updated: 1 });
    expect(await emergencyJobs()).toBe(1);
    const [row] = await tdb.db.select().from(items).where(eq(items.key, emergencyItemKey("g-2")));
    expect(row).toMatchObject({ title: "Alert 2 (updated)", summary: "New text" });
  });

  it("a 200 HTML page records nothing and reports not-a-feed; the next check retries", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run(serving("<!doctype html><html><body>Maintenance</body></html>"));
    expect(r.result).toMatchObject({ ok: false, error: "not-a-feed", created: 0 });
    expect(await getEmergencyFeedStatus(tdb.db, URL_A)).toMatchObject({ url: URL_A, result: { ok: false, error: "not-a-feed" } });
    later(5);
    expect((await run(serving(renderFeedXml([alert(1)])))).result).toMatchObject({ ok: true, seeded: true });
    spy.mockRestore();
  });

  it("an HTTP error is recorded by status, and the log carries only that label", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run(serving("nope", 503))).result).toMatchObject({ ok: false, error: "http-503" });
    expect(spy.mock.calls.flat().join(" ")).toBe("[nod] emergency feed check failed: http-503");
    spy.mockRestore();
  });

  it("an emergency alert reaches a digest-only subscriber (everyone on the list, whatever their timing)", async () => {
    await run(serving(renderFeedXml([alert(1)])));
    later(5);
    await run(serving(renderFeedXml([alert(2), alert(1)])));
    const { rows } = await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM deliveries WHERE item_key = ${emergencyItemKey("g-2")}`);
    expect(rows[0]!.n).toBe(1);
  });

  it("a raw control character in one alert's title no longer stops the alerts around it", async () => {
    const feed = renderFeedXml([alert(1), alert(2, { title: "Evac\u0000uation order" }), alert(3)]);
    const r = await run(serving(feed));
    expect(r.result).toMatchObject({ ok: true, inFeed: 3, created: 3, failed: 0 });
    const [row] = await tdb.db.select({ title: items.title }).from(items).where(eq(items.key, emergencyItemKey("g-2")));
    expect(row!.title).toBe("Evacuation order");
  });

  it("a bad item doesn't stop the alerts around it; seeding leaves the run not-ok and re-seeds next time", async () => {
    const badGuid = "g-bad";
    const throwingItems: Pick<ItemSending, "recordEmergencyItem"> = {
      recordEmergencyItem(db, input, opts) {
        if (input.guid === badGuid) throw new Error("boom");
        return sending.recordEmergencyItem(db, input, opts);
      },
    };
    const feed = renderFeedXml([alert(1), alert(2, { guid: badGuid }), alert(3)]);

    const r1 = await runEmergencyFeedIfDue({ db: tdb.db, url: URL_A, items: throwingItems, fetch: serving(feed), now });
    expect(r1.result).toMatchObject({ ok: false, seeded: true, inFeed: 3, created: 2, failed: 1 });
    expect(await emergencyJobs()).toBe(0);
    const [settingsRow] = await tdb.db.select({ seededUrl: nodSettings.emergencyFeedSeededUrl }).from(nodSettings).where(eq(nodSettings.id, 1));
    expect(settingsRow!.seededUrl).toBeNull();

    later(5);
    const r2 = await run(serving(feed));
    expect(r2.result).toMatchObject({ ok: true, seeded: true, inFeed: 3, created: 1, failed: 0 });
    // Still seeding (the first run never committed a seeded url), so the alert that failed
    // last time is recorded now but, same as any other seeded alert, never emailed as new.
    expect(await emergencyJobs()).toBe(0);
  });

  it("recognizes a known alert whose link only changed case, scheme or a trailing slash", async () => {
    await run(serving(renderFeedXml([alert(1, { link: "https://emergency.example.test/alerts/1" })])));
    later(5);
    const r = await run(serving(renderFeedXml([alert(1, { guid: "g-1-renamed", link: "HTTP://Emergency.Example.Test/alerts/1/" })])));
    expect(r.result).toMatchObject({ created: 0, updated: 0 });
    expect(await emergencyJobs()).toBe(0);
  });

  it("two concurrent checks produce exactly one ran:true", async () => {
    const f = serving(renderFeedXml([alert(1)]));
    const [a, b] = await Promise.all([run(f), run(f)]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
  });
});

describe("fetchFeed", () => {
  it("rejects a body over the cap", async () => {
    const big = new Response(new Uint8Array(MAX_FEED_BYTES + 1));
    await expect(fetchFeed("https://emergency.example.test/feed.xml", asFetch(async () => big))).rejects.toMatchObject({ kind: "too-large" });
  });
  it("rejects a body whose chunks only exceed the cap cumulatively, not on their own", async () => {
    const chunkSize = Math.floor(MAX_FEED_BYTES / 4);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(chunkSize));
        controller.close();
      },
    });
    await expect(fetchFeed("https://emergency.example.test/feed.xml", asFetch(async () => new Response(stream)))).rejects.toMatchObject({ kind: "too-large" });
  });
  it("names a timeout as such", async () => {
    const abort = asFetch(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(fetchFeed("https://emergency.example.test/feed.xml", abort)).rejects.toBeInstanceOf(FeedFetchError);
    await expect(fetchFeed("https://emergency.example.test/feed.xml", abort)).rejects.toMatchObject({ kind: "timeout" });
  });
  it("follows no redirects; the operator must configure the feed's own final URL", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(301, { Location: "https://example.test/elsewhere" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(fetchFeed(`http://127.0.0.1:${port}/`, fetch)).rejects.toMatchObject({ kind: "redirect" });
    } finally {
      server.close();
    }
  });
});
