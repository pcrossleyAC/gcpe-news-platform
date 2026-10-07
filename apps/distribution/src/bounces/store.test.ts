import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../../test/helpers";
import { batches, bounces, messages } from "../db/schema";
import type { ParsedBounce } from "./parse";
import { recordBounce } from "./store";

const HARD_BOUNCE: ParsedBounce = { kind: "bounce", recipient: "alex@example.test", status: "5.1.1", hard: true, originalMessageId: null, method: "rfc3464" };
const SOFT_BOUNCE: ParsedBounce = { kind: "bounce", recipient: "alex@example.test", status: "4.4.7", hard: false, originalMessageId: null, method: "rfc3464" };

async function seedMessage(
  db: Db,
  opts: {
    appId?: string;
    email?: string;
    status?: "pending" | "sent" | "failed";
    sentAt?: Date | null;
    messageId?: string | null;
    originalRecipient?: string | null;
    bounceHard?: boolean | null;
  } = {},
): Promise<{ batchId: string; messageId: string; appId: string }> {
  const appId = opts.appId ?? "nod";
  const [batch] = await db.insert(batches).values({ appId, subject: "Weekend clinics open", html: "<p>hi</p>" }).returning({ id: batches.id });
  const [message] = await db
    .insert(messages)
    .values({
      batchId: batch!.id,
      email: opts.email ?? "alex@example.test",
      priority: 0,
      status: opts.status ?? "sent",
      sentAt: opts.sentAt === undefined ? new Date() : (opts.sentAt ?? undefined),
      messageId: opts.messageId ?? null,
      originalRecipient: opts.originalRecipient ?? null,
      bounceHard: opts.bounceHard ?? null,
    })
    .returning({ id: messages.id });
  return { batchId: batch!.id, messageId: message!.id, appId };
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 3_600_000);

describe("recordBounce", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.execute(sql`TRUNCATE TABLE bounces, messages, batches`);
  });

  it("matches by Message-ID, with or without brackets and surrounding whitespace", async () => {
    const seeded = await seedMessage(tdb.db, { messageId: "<row-1@dist.example.test>" });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-1", "raw", { ...HARD_BOUNCE, originalMessageId: "  row-1@dist.example.test  " }),
    );

    expect(result.duplicate).toBe(false);
    expect(result.matched).toEqual({ messageId: seeded.messageId, batchId: seeded.batchId, appId: seeded.appId, email: "alex@example.test" });
  });

  it("falls back to the most recent sent message to the recipient within 4 days when there's no Message-ID match", async () => {
    const older = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(3) });
    const newer = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });
    void older;

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-2", "raw", HARD_BOUNCE));

    expect(result.matched?.messageId).toBe(newer.messageId);
  });

  it("does not match a sent message older than 4 days", async () => {
    await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(5) });

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-3", "raw", HARD_BOUNCE));

    expect(result.matched).toBeNull();
  });

  it("records an unmatched bounce with matched: false and no message row touched", async () => {
    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-4", "raw", HARD_BOUNCE));

    expect(result.matched).toBeNull();
    expect(result.duplicate).toBe(false);
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-4'`);
    expect(row?.matched).toBe(false);
    expect(row?.messageId).toBeNull();
  });

  it("reports the intended recipient (messages.email), not the redirect address, for a redirected message", async () => {
    const seeded = await seedMessage(tdb.db, {
      email: "alex@example.test",
      originalRecipient: "alex@example.test",
      messageId: "<row-redirect@dist.example.test>",
    });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-5", "raw", { ...HARD_BOUNCE, recipient: "tester@mailtrap.example.test", originalMessageId: "<row-redirect@dist.example.test>" }),
    );

    expect(result.matched?.email).toBe("alex@example.test");
    expect(result.matched?.messageId).toBe(seeded.messageId);
  });

  it("a duplicate source_id reports duplicate: true and changes nothing", async () => {
    const seeded = await seedMessage(tdb.db, { messageId: "<row-dup@dist.example.test>" });
    const parsed: ParsedBounce = { ...HARD_BOUNCE, originalMessageId: "<row-dup@dist.example.test>" };

    const first = await tdb.db.transaction((tx) => recordBounce(tx, "src-6", "raw-1", parsed));
    const second = await tdb.db.transaction((tx) => recordBounce(tx, "src-6", "raw-2", parsed));

    expect(second).toEqual({ bounceId: first.bounceId, matched: null, duplicate: true });
    const rows = await tdb.db.select().from(bounces).where(sql`source_id = 'src-6'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toBe("raw-1");

    const [message] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(message!.bouncedAt).not.toBeNull();
  });

  it("a soft bounce after a hard one keeps the hard", async () => {
    const seeded = await seedMessage(tdb.db, { messageId: "<row-7@dist.example.test>" });

    await tdb.db.transaction((tx) => recordBounce(tx, "src-7a", "raw", { ...HARD_BOUNCE, originalMessageId: "<row-7@dist.example.test>" }));
    const [afterHard] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(afterHard!.bounceHard).toBe(true);
    const hardBouncedAt = afterHard!.bouncedAt;

    await tdb.db.transaction((tx) => recordBounce(tx, "src-7b", "raw", { ...SOFT_BOUNCE, originalMessageId: "<row-7@dist.example.test>" }));
    const [afterSoft] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(afterSoft!.bounceHard).toBe(true);
    expect(afterSoft!.bounceStatus).toBe("5.1.1");
    expect(afterSoft!.bouncedAt).toEqual(hardBouncedAt);

    // The soft bounce itself is still recorded as its own row, matched to the same message.
    const [softRow] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-7b'`);
    expect(softRow?.matched).toBe(true);
    expect(softRow?.hard).toBe(false);
  });

  it("records an ignored message with matched: false and no bounce columns touched", async () => {
    const seeded = await seedMessage(tdb.db, { messageId: "<row-8@dist.example.test>" });

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-8", "raw", { kind: "ignored", reason: "auto-reply" }));

    expect(result.matched).toBeNull();
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-8'`);
    expect(row).toMatchObject({ kind: "ignored", matched: false, messageId: null, recipient: null, status: null, hard: null, method: null });
    const [message] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(message!.bouncedAt).toBeNull();
  });
});
