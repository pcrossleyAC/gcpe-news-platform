import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { deliveries, items, subscribers } from "../db/schema";
import { resolveRange, localDate } from "./range";
import { RELEASE_SENDS_CSV_HEADER, releaseSendBatches, releaseSendCsvRow, releaseSendsPage, releaseSendsSql } from "./release-sends";
import { csvLine } from "./csv";

const BC = "America/Vancouver";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const HOSTILE = '=HYPERLINK("http://x","y")';

describe("sends per release", () => {
  let tdb: TestDatabase;
  const range = () => resolveRange({}, localDate(new Date(), BC), BC);

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s1, s2, s3, s4] = await tdb.db
      .insert(subscribers)
      .values(["s1", "s2", "s3", "s4"].map((n) => ({ email: `${n}@example.test`, status: "active" as const })))
      .returning({ id: subscribers.id });
    await tdb.db.insert(items).values([
      { key: "r1", kind: "release", postKind: "releases", title: HOSTILE, url: "https://news.example/r1", publishedAt: daysAgo(2) },
      { key: "r2", kind: "release", postKind: "releases", title: "Too old", url: "https://news.example/r2", publishedAt: daysAgo(40) },
      { key: "r3", kind: "release", postKind: "stories", title: "Nobody matched", url: "https://news.example/r3", publishedAt: daysAgo(1) },
      { key: "e1", kind: "emergency", title: "Wildfire alert", url: "https://news.example/e1", publishedAt: daysAgo(1) },
    ]);
    const sent = { attemptedAt: daysAgo(1), distributionBatchId: randomUUID() };
    await tdb.db.insert(deliveries).values([
      { itemKey: "r1", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
      { itemKey: "r1", subscriberId: s2!.id, mode: "as_it_happens", ...sent, bounceStatus: "5.1.1", hardBouncedAt: daysAgo(1) },
      { itemKey: "r1", subscriberId: s3!.id, mode: "as_it_happens" },
      { itemKey: "r1", subscriberId: s4!.id, mode: "as_it_happens", ...sent, bounceStatus: "4.2.2" },
      { itemKey: "r1", subscriberId: s1!.id, mode: "media", ...sent },
      { itemKey: "r1", subscriberId: s2!.id, mode: "digest", ...sent },
      { itemKey: "r2", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
      { itemKey: "e1", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts each sent item in the range by mode, newest first, leaving out digest rows and items nobody got", async () => {
    const page = await releaseSendsPage(tdb.db, range(), 1);
    expect(page.total).toBe(2);
    expect(page.items.map((i) => [i.itemKey, i.type])).toEqual([
      ["e1", "Emergency alert"],
      ["r1", "News release"],
    ]);
    const r1 = page.items[1]!;
    expect(r1.title).toBe(HOSTILE);
    expect(r1.asItHappens).toEqual({ recipients: 4, handedOffNotBounced: 1, bounced: 2, notSent: 1 });
    expect(r1.media).toEqual({ recipients: 1, handedOffNotBounced: 1, bounced: 0, notSent: 0 });
  });

  it("batches the same rows for the CSV, with the hostile title neutralised", async () => {
    const all = [];
    for await (const b of releaseSendBatches(tdb.db, range(), 1)) all.push(...b);
    expect(all.map((r) => r.itemKey)).toEqual(["e1", "r1"]);
    const line = csvLine(releaseSendCsvRow(all[1]!, BC));
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},"'=HYPERLINK\(""http:\/\/x"",""y""\)",News release,4,1,2,1,1,1,0,0\r\n$/);
  });

  it("names the count what it is: handed to Distribution and not bounced, not delivered", () => {
    expect(RELEASE_SENDS_CSV_HEADER).toContain("As it happens: handed off, not bounced");
    expect(RELEASE_SENDS_CSV_HEADER).toContain("Media: handed off, not bounced");
    expect(RELEASE_SENDS_CSV_HEADER.join(",")).not.toMatch(/delivered/i);
  });

  it("a release published while the CSV is being written is neither repeated nor skipped", async () => {
    const [late] = await tdb.db.insert(subscribers).values({ email: "late@example.test", status: "active" }).returning({ id: subscribers.id });
    try {
      const keys: string[] = [];
      for await (const b of releaseSendBatches(tdb.db, range(), 1)) {
        keys.push(...b.map((r) => r.itemKey));
        if (keys.length === 1) {
          // Lands at the top of the newest-first order, ahead of every row still to come.
          await tdb.db.insert(items).values({ key: "late", kind: "release", postKind: "releases", title: "Late", url: "https://news.example/late", publishedAt: new Date() });
          await tdb.db.insert(deliveries).values({ itemKey: "late", subscriberId: late!.id, mode: "as_it_happens" });
        }
      }
      expect(keys).toEqual(["e1", "r1"]);
    } finally {
      await tdb.db.delete(deliveries).where(inArray(deliveries.itemKey, ["late"]));
      await tdb.db.delete(items).where(inArray(items.key, ["late"]));
    }
  });

  it("indexes only as-it-happens and media deliveries for this report", async () => {
    const { rows } = await tdb.db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'deliveries_item_mode_idx'`);
    expect(rows[0]!.indexdef).toMatch(/WHERE \(mode = ANY \(ARRAY\['as_it_happens'::text, 'media'::text\]\)\)/);
  });

  it("reads deliveries through the item/mode covering index and items by publish time", async () => {
    await tdb.db.execute(sql`VACUUM ANALYZE deliveries`);
    const plan = await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${releaseSendsSql(range(), 25, 0)}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("Index Only Scan using deliveries_item_mode_idx");
    expect(plan).toContain("items_published_at_idx");
  });
});
