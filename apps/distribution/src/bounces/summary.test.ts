import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../../test/helpers";
import { batches, bounces, messages } from "../db/schema";
import { bounceSummary, SUMMARY_ROW_LIMIT } from "./summary";

const SINCE = new Date("2026-10-06T15:00:00.000Z");
const UNTIL = new Date("2026-10-07T15:00:00.000Z");
const inWindow = (minutes: number) => new Date(SINCE.getTime() + minutes * 60_000);

describe("bounceSummary", () => {
  let tdb: TestDatabase;
  let seq = 0;
  const src = () => `summary-src-${++seq}`;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE bounces, messages, batches CASCADE");
  });

  async function message(appId: string, email: string, priority: number, subject = "BC Gov News - Clinics open"): Promise<string> {
    const [b] = await tdb.db.insert(batches).values({ appId, subject }).returning({ id: batches.id });
    const [m] = await tdb.db.insert(messages).values({ batchId: b!.id, email, priority, status: "sent" }).returning({ id: messages.id });
    return m!.id;
  }

  it("counts everything in (since, until] and lists soft and unrecorded rows", async () => {
    const softId = await message("nod", "intended@example.test", 30);
    const otherAppSoft = await message("nrms", "staff@example.test", 30);
    const verifyId = await message("nod", "typo@example.test", 100, "BC Gov News On Demand Email Verification");
    const releaseHard = await message("nod", "hard@example.test", 30);
    await tdb.db.insert(bounces).values([
      // Matched soft, ours: on a test site recipient is the redirect mailbox; the row shows messages.email.
      { sourceId: src(), raw: "x", kind: "bounce", hard: false, status: "4.2.2", diagnostic: "452 4.2.2 mailbox full", recipient: "redirect@example.test", messageId: softId, matched: true, processedAt: inWindow(1) },
      // Matched soft, another app's: counted in processed/bounces, not listed.
      { sourceId: src(), raw: "x", kind: "bounce", hard: false, status: "4.4.7", recipient: "staff@example.test", messageId: otherAppSoft, matched: true, processedAt: inWindow(2) },
      // Unmatched: listed with its parsed original subject.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", diagnostic: "550 5.1.1 not found", originalSubject: "Old release", recipient: "gone@example.test", matched: false, processedAt: inWindow(3) },
      // Matched hard bounce of our verification email: unrecorded (NoD has no delivery row for it).
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.2", recipient: "typo@example.test", messageId: verifyId, matched: true, processedAt: inWindow(4) },
      // Matched hard bounce of a release: NoD's own hard line, never in these lists.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "hard@example.test", messageId: releaseHard, matched: true, processedAt: inWindow(5) },
      { sourceId: src(), raw: "x", kind: "ignored", processedAt: inWindow(6) },
      // Outside the window on both sides.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "early@example.test", matched: false, processedAt: SINCE },
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "late@example.test", matched: false, processedAt: new Date(UNTIL.getTime() + 1) },
    ]);

    const s = await bounceSummary(tdb.db, { since: SINCE, until: UNTIL, appId: "nod" });

    expect({ processed: s.processed, bounces: s.bounces, ignored: s.ignored }).toEqual({ processed: 6, bounces: 5, ignored: 1 });
    expect(s.soft.count).toBe(1);
    expect(s.soft.rows).toEqual([
      { address: "intended@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics open", processedAt: inWindow(1).toISOString() },
    ]);
    expect(s.unrecorded.count).toBe(2);
    expect(s.unrecorded.rows.map((r) => [r.address, r.status, r.subject])).toEqual([
      ["gone@example.test", "5.1.1", "Old release"],
      ["typo@example.test", "5.1.2", "BC Gov News On Demand Email Verification"],
    ]);
  });

  it(`lists at most ${SUMMARY_ROW_LIMIT} rows per list but counts them all`, async () => {
    await tdb.db.insert(bounces).values(
      Array.from({ length: SUMMARY_ROW_LIMIT + 1 }, (_, i) => ({
        sourceId: src(), raw: "x", kind: "bounce" as const, hard: true, status: "5.1.1", recipient: `n${i}@example.test`, matched: false, processedAt: inWindow(1),
      })),
    );
    const s = await bounceSummary(tdb.db, { since: SINCE, until: UNTIL, appId: "nod" });
    expect(s.unrecorded.count).toBe(SUMMARY_ROW_LIMIT + 1);
    expect(s.unrecorded.rows).toHaveLength(SUMMARY_ROW_LIMIT);
  });
});
