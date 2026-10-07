import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { createDistributionTestDb } from "../../test/helpers";
import { batches, bounces, messages, outboxDeliveries, outboxEvents } from "../db/schema";
import { messageIdFor } from "../sender";
import { parseBounce, type ParsedBounce } from "./parse";
import { recordBounce } from "./store";

const NO_SUBSCRIBERS: SubscriberConfig[] = [];

// The domain env.ts's MESSAGE_ID_DOMAIN resolves to in production -- every test below that
// cares about Message-ID matching passes this as recordBounce's own `messageIdDomain`.
const DOMAIN = "dist.example.test";

const HARD_BOUNCE: ParsedBounce = { kind: "bounce", recipient: "alex@example.test", status: "5.1.1", hard: true, originalMessageId: null, method: "rfc3464" };
const SOFT_BOUNCE: ParsedBounce = { kind: "bounce", recipient: "alex@example.test", status: "4.4.7", hard: false, originalMessageId: null, method: "rfc3464" };

async function seedMessage(
  db: Db,
  opts: {
    appId?: string;
    email?: string;
    status?: "pending" | "sent" | "failed";
    sentAt?: Date | null;
    /** When given, `messages.message_id` is set to `messageIdFor(<this row's own id>, domain)`
     * -- real sends always derive their stored Message-ID from their own primary key
     * (sender.ts's messageIdFor), so a test fixture does the same rather than writing some
     * other arbitrary string. */
    domain?: string;
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
      originalRecipient: opts.originalRecipient ?? null,
      bounceHard: opts.bounceHard ?? null,
    })
    .returning({ id: messages.id });
  const id = message!.id;
  if (opts.domain) {
    await db.update(messages).set({ messageId: messageIdFor(id, opts.domain) }).where(eq(messages.id, id));
  }
  return { batchId: batch!.id, messageId: id, appId };
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 3_600_000);

const fixturesDir = fileURLToPath(new URL("../../test/fixtures/bounces", import.meta.url));
const fixture = (name: string): string => readFileSync(`${fixturesDir}/${name}`, "utf8");

describe("recordBounce", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.execute(sql`TRUNCATE TABLE bounces, messages, batches, outbox_deliveries, outbox_events`);
  });

  it("matches by Message-ID (the local part is the row's own id), with or without brackets and surrounding whitespace", async () => {
    const seeded = await seedMessage(tdb.db, { domain: DOMAIN });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-1", "raw", { ...HARD_BOUNCE, originalMessageId: `  ${seeded.messageId}@${DOMAIN}  ` }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.duplicate).toBe(false);
    expect(result.matched).toEqual({ messageId: seeded.messageId, batchId: seeded.batchId, appId: seeded.appId, email: "alex@example.test" });
  });

  it("falls back to the most recent sent message to the recipient within 4 days when there's no Message-ID match", async () => {
    const older = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(3) });
    const newer = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });
    void older;

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-2", "raw", HARD_BOUNCE, NO_SUBSCRIBERS, DOMAIN));

    expect(result.matched?.messageId).toBe(newer.messageId);
  });

  it("does not match a sent message older than 4 days", async () => {
    await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(5) });

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-3", "raw", HARD_BOUNCE, NO_SUBSCRIBERS, DOMAIN));

    expect(result.matched).toBeNull();
  });

  it("records an unmatched bounce with matched: false and no message row touched", async () => {
    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-4", "raw", HARD_BOUNCE, NO_SUBSCRIBERS, DOMAIN));

    expect(result.matched).toBeNull();
    expect(result.duplicate).toBe(false);
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-4'`);
    expect(row?.matched).toBe(false);
    expect(row?.messageId).toBeNull();
  });

  it("reports the intended recipient (messages.email), not the redirect address, for a redirected message", async () => {
    const seeded = await seedMessage(tdb.db, { email: "alex@example.test", originalRecipient: "alex@example.test", domain: DOMAIN });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(
        tx,
        "src-5",
        "raw",
        { ...HARD_BOUNCE, recipient: "tester@mailtrap.example.test", originalMessageId: `<${seeded.messageId}@${DOMAIN}>` },
        NO_SUBSCRIBERS,
        DOMAIN,
      ),
    );

    expect(result.matched?.email).toBe("alex@example.test");
    expect(result.matched?.messageId).toBe(seeded.messageId);
  });

  it("a duplicate source_id reports duplicate: true and changes nothing", async () => {
    const seeded = await seedMessage(tdb.db, { domain: DOMAIN });
    const parsed: ParsedBounce = { ...HARD_BOUNCE, originalMessageId: `<${seeded.messageId}@${DOMAIN}>` };

    const first = await tdb.db.transaction((tx) => recordBounce(tx, "src-6", "raw-1", parsed, NO_SUBSCRIBERS, DOMAIN));
    const second = await tdb.db.transaction((tx) => recordBounce(tx, "src-6", "raw-2", parsed, NO_SUBSCRIBERS, DOMAIN));

    expect(second).toEqual({ bounceId: first.bounceId, matched: null, duplicate: true });
    const rows = await tdb.db.select().from(bounces).where(sql`source_id = 'src-6'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw).toBe("raw-1");

    const [message] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(message!.bouncedAt).not.toBeNull();
  });

  it("a soft bounce after a hard one keeps the hard", async () => {
    const seeded = await seedMessage(tdb.db, { domain: DOMAIN });
    const originalMessageId = `<${seeded.messageId}@${DOMAIN}>`;

    await tdb.db.transaction((tx) => recordBounce(tx, "src-7a", "raw", { ...HARD_BOUNCE, originalMessageId }, NO_SUBSCRIBERS, DOMAIN));
    const [afterHard] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(afterHard!.bounceHard).toBe(true);
    const hardBouncedAt = afterHard!.bouncedAt;

    await tdb.db.transaction((tx) => recordBounce(tx, "src-7b", "raw", { ...SOFT_BOUNCE, originalMessageId }, NO_SUBSCRIBERS, DOMAIN));
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
    const seeded = await seedMessage(tdb.db, { domain: DOMAIN });

    const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-8", "raw", { kind: "ignored", reason: "auto-reply" }, NO_SUBSCRIBERS, DOMAIN));

    expect(result.matched).toBeNull();
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-8'`);
    expect(row).toMatchObject({ kind: "ignored", matched: false, messageId: null, recipient: null, status: null, hard: null, method: null });
    const [message] = await tdb.db.select().from(messages).where(sql`id = ${seeded.messageId}`);
    expect(message!.bouncedAt).toBeNull();
  });

  // Controller ruling: two recordBounce calls racing on the same source_id, in separate
  // (genuinely concurrent, not just sequential) transactions — the unique index must settle it
  // with no thrown error, exactly one stored row, and exactly one duplicate: true.
  it("two concurrent recordBounce calls with the same source_id: exactly one bounce row, one duplicate: true, no error", async () => {
    const parsed: ParsedBounce = { ...HARD_BOUNCE, originalMessageId: null, recipient: "racer@example.test" };

    const [first, second] = await Promise.all([
      tdb.db.transaction((tx) => recordBounce(tx, "src-race", "raw-a", parsed, NO_SUBSCRIBERS, DOMAIN)),
      tdb.db.transaction((tx) => recordBounce(tx, "src-race", "raw-b", parsed, NO_SUBSCRIBERS, DOMAIN)),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.duplicate)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.duplicate)).toHaveLength(1);
    const rows = await tdb.db.select().from(bounces).where(sql`source_id = 'src-race'`);
    expect(rows).toHaveLength(1);
  });

  // Message-ID domains are case-insensitive (RFC 5321/5322); the local part (the row's own
  // uuid) is matched by primary key, which Postgres's uuid type already treats
  // case-insensitively.
  it("matches the Message-ID domain case-insensitively", async () => {
    const seeded = await seedMessage(tdb.db, { domain: "Dist.Example.TEST" });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-ci", "raw", { ...HARD_BOUNCE, originalMessageId: `<${seeded.messageId}@dist.example.test>` }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.matched?.messageId).toBe(seeded.messageId);
  });

  it("a non-uuid local part is never looked up by primary key, but still falls back to the recipient when the domain is ours", async () => {
    // Deliberately *not* this row's real id -- a legacy/hand-crafted Message-ID whose local
    // part was never one of ours to begin with.
    const seeded = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-non-uuid", "raw", { ...HARD_BOUNCE, originalMessageId: `<legacy-id-123@${DOMAIN}>` }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.matched?.messageId).toBe(seeded.messageId);
  });

  it("a Message-ID on a foreign domain is left unmatched, even with a recent sent message to the recipient", async () => {
    await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-foreign", "raw", { ...HARD_BOUNCE, originalMessageId: "<some-id@legacy.example.com>" }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.matched).toBeNull();
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-foreign'`);
    expect(row?.matched).toBe(false);
  });

  it("a uuid-shaped Message-ID on our own domain that resolves to no row still falls back to the recipient", async () => {
    const seeded = await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-ours-not-found", "raw", { ...HARD_BOUNCE, originalMessageId: `<00000000-0000-0000-0000-000000000099@${DOMAIN}>` }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.matched?.messageId).toBe(seeded.messageId);
  });

  // A present-but-unparseable Message-ID (no '@' at all, or nothing on one side of it) is
  // different from no Message-ID at all: it names *something*, just not in the "local@domain"
  // shape ours always has -- so it's treated the same as a foreign domain (unmatched), never as
  // "no id to check, go ahead and fall back".
  it("a Message-ID with no '@' at all is left unmatched, even with a recent sent message to the recipient", async () => {
    await seedMessage(tdb.db, { email: "alex@example.test", sentAt: daysAgo(1) });

    const result = await tdb.db.transaction((tx) =>
      recordBounce(tx, "src-no-at", "raw", { ...HARD_BOUNCE, originalMessageId: "<not-an-address-at-all>" }, NO_SUBSCRIBERS, DOMAIN),
    );

    expect(result.matched).toBeNull();
    const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-no-at'`);
    expect(row?.matched).toBe(false);
  });

  describe("recipient fallback query plan", () => {
    it("uses the lower(email)/sent_at index instead of a sequential scan, on a seeded table", async () => {
      const [batch] = await tdb.db.insert(batches).values({ appId: "nod", subject: "s", html: "<p>h</p>" }).returning({ id: batches.id });
      // Enough rows, and enough distinct emails, that the planner's own cost estimates (not a
      // forced setting) prefer the partial index over a sequential scan -- the same shape of
      // check the final reviewer's probe (scratchpad/probe/scan.test.ts) ran at 2M rows, just
      // at a size this suite can afford to seed on every run.
      await tdb.db.execute(sql.raw(`
        INSERT INTO messages (batch_id, email, priority, status, sent_at)
        SELECT '${batch!.id}', 'user' || g || '@example.test', 30, 'sent', now() - (g || ' seconds')::interval
        FROM generate_series(1, 50000) g
      `));
      await tdb.db.execute(sql`ANALYZE messages`);

      const { rows } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`
        EXPLAIN SELECT messages.id FROM messages
         WHERE status = 'sent'
           AND lower(email) = lower('user-25000@example.test')
           AND sent_at >= now() - interval '4 days'
           AND sent_at <= now()
         ORDER BY sent_at DESC
         LIMIT 1
      `);
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("messages_sent_email_lower_idx");
      expect(plan).not.toContain("Seq Scan");
    }, 30_000);
  });

  describe("NUL bytes", () => {
    it("strips NUL bytes from raw and every parsed text field before storing", async () => {
      const parsed: ParsedBounce = { kind: "bounce", recipient: "alex@example.test\u0000evil", status: "5.1.1\u0000", hard: true, originalMessageId: null, method: "rfc3464" };

      const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-nul-1", "raw\u0000content", parsed, NO_SUBSCRIBERS, DOMAIN));

      expect(result.duplicate).toBe(false);
      const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-nul-1'`);
      expect(row!.raw).toBe("rawcontent");
      expect(row!.recipient).toBe("alex@example.testevil");
      expect(row!.status).toBe("5.1.1");
    });

    it("feeds the repo's malformed.eml (containing 0x00) through, and a row is stored", async () => {
      const raw = fixture("malformed.eml");
      expect(raw).toContain("\u0000");
      const parsed = await parseBounce(raw);

      const result = await tdb.db.transaction((tx) => recordBounce(tx, "src-nul-2", raw, parsed, NO_SUBSCRIBERS, DOMAIN));

      expect(result.duplicate).toBe(false);
      const [row] = await tdb.db.select().from(bounces).where(sql`source_id = 'src-nul-2'`);
      expect(row).toBeDefined();
      expect(row!.raw).not.toContain("\u0000");
      expect(row!.kind).toBe("ignored");
    });
  });

  describe("delivery.bounced outbox event", () => {
    it("a matched bounce writes exactly one outbox row, carrying the matched message's own data", async () => {
      const seeded = await seedMessage(tdb.db, { appId: "nod", email: "alex@example.test", domain: DOMAIN });

      const result = await tdb.db.transaction((tx) =>
        recordBounce(tx, "src-outbox-1", "raw", { ...HARD_BOUNCE, originalMessageId: `<${seeded.messageId}@${DOMAIN}>` }, NO_SUBSCRIBERS, DOMAIN),
      );

      const rows = await tdb.db.select().from(outboxEvents).where(sql`type = 'delivery.bounced'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.aggregateId).toBe(`message:${result.matched!.messageId}`);
      const envelope = rows[0]!.envelope as { source: string; type: string; data: Record<string, unknown> };
      expect(envelope.source).toBe("distribution");
      expect(envelope.type).toBe("delivery.bounced");
      expect(envelope.data).toMatchObject({
        appId: "nod",
        batchId: seeded.batchId,
        messageId: seeded.messageId,
        email: "alex@example.test",
        hard: true,
        status: "5.1.1",
      });
      expect(envelope.data.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*(Z|[+-]\d{2}:\d{2})$/);
    });

    it("an unmatched bounce writes no outbox row", async () => {
      await tdb.db.transaction((tx) => recordBounce(tx, "src-outbox-2", "raw", HARD_BOUNCE, NO_SUBSCRIBERS, DOMAIN));

      const rows = await tdb.db.select().from(outboxEvents).where(sql`type = 'delivery.bounced'`);
      expect(rows).toHaveLength(0);
    });

    it("an ignored message writes no outbox row", async () => {
      await seedMessage(tdb.db, { domain: DOMAIN });

      await tdb.db.transaction((tx) => recordBounce(tx, "src-outbox-3", "raw", { kind: "ignored", reason: "auto-reply" }, NO_SUBSCRIBERS, DOMAIN));

      const rows = await tdb.db.select().from(outboxEvents).where(sql`type = 'delivery.bounced'`);
      expect(rows).toHaveLength(0);
    });

    it("a duplicate source_id writes no additional outbox row", async () => {
      const seeded = await seedMessage(tdb.db, { domain: DOMAIN });
      const parsed: ParsedBounce = { ...HARD_BOUNCE, originalMessageId: `<${seeded.messageId}@${DOMAIN}>` };

      await tdb.db.transaction((tx) => recordBounce(tx, "src-outbox-4", "raw-1", parsed, NO_SUBSCRIBERS, DOMAIN));
      await tdb.db.transaction((tx) => recordBounce(tx, "src-outbox-4", "raw-2", parsed, NO_SUBSCRIBERS, DOMAIN));

      const rows = await tdb.db.select().from(outboxEvents).where(sql`type = 'delivery.bounced'`);
      expect(rows).toHaveLength(1);
    });

    it("queues a delivery for every subscriber configured for delivery.bounced", async () => {
      const seeded = await seedMessage(tdb.db, { domain: DOMAIN });
      const subscribers: SubscriberConfig[] = [{ name: "nod", url: "https://nod.example.test/events", secret: "s".repeat(16), types: ["delivery.bounced"] }];

      await tdb.db.transaction((tx) =>
        recordBounce(tx, "src-outbox-5", "raw", { ...HARD_BOUNCE, originalMessageId: `<${seeded.messageId}@${DOMAIN}>` }, subscribers, DOMAIN),
      );

      const deliveries = await tdb.db.select().from(outboxDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.subscriber).toBe("nod");
    });
  });
});
