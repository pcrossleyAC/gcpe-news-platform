import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createBatch } from "./messages";
import { messages } from "./db/schema";
import { createDistributionTestDb, sampleMessageRequest } from "../test/helpers";
import { startSmtpSink } from "../test/smtp-sink";
import { sendDue } from "./sender";

const internalDomains = ["gov.bc.ca"];

describe("sendDue", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  // Each test's `result` assertions count every due message in the table, so the table must
  // be empty of any other test's leftovers (e.g. a test that deliberately leaves a row
  // pending) before it starts.
  beforeEach(async () => {
    await tdb.db.execute(sql`TRUNCATE TABLE messages, batches`);
  });

  it("sends each recipient their own substituted mail", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, headers: { "List-Unsubscribe": "<mailto:bye+{{name}}@example.com>" } },
        internalDomains,
      );

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });

      expect(result).toEqual({ sent: 2, retried: 0, failed: 0 });
      expect(sink.messages).toHaveLength(2);
      const byTo = new Map(sink.messages.map((m) => [m.to && "value" in m.to ? m.to.value[0]!.address : undefined, m]));
      const alex = byTo.get("alex.example@gov.bc.ca")!;
      const sam = byTo.get("sam.example@example.com")!;
      expect(alex.html).toContain("Hi Alex,");
      expect(sam.html).toContain("Hi Sam,");
      // mailparser parses List-Unsubscribe into a structured "list" header rather than
      // keeping it as raw text, so the substituted address is checked at that path.
      expect((alex.headers.get("list") as unknown as { unsubscribe: { mail: string } }).unsubscribe.mail).toBe("bye+Alex@example.com");
      expect((sam.headers.get("list") as unknown as { unsubscribe: { mail: string } }).unsubscribe.mail).toBe("bye+Sam@example.com");

      const rows = await tdb.db.select().from(messages);
      expect(rows.every((r) => r.status === "sent")).toBe(true);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("redirects to the configured address, preserving the original recipient", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", sampleMessageRequest, internalDomains);
      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: ["qa@example.com"] });

      expect(sink.messages).toHaveLength(2);
      for (const m of sink.messages) {
        expect(m.to && "value" in m.to ? m.to.value.map((a) => a.address) : []).toEqual(["qa@example.com"]);
      }
      const originalTos = sink.messages.map((m) => m.headers.get("x-original-to")).sort();
      expect(originalTos).toEqual(["alex.example@gov.bc.ca", "sam.example@example.com"]);

      const rows = await tdb.db.select().from(messages);
      expect(rows.map((r) => r.originalRecipient).sort()).toEqual(["alex.example@gov.bc.ca", "sam.example@example.com"]);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("sends higher-priority batches first", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "digest", recipients: [{ email: "digest@example.com", substitutions: {} }] }, internalDomains);
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "system@example.com", substitutions: {} }] }, internalDomains);

      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], batchSize: 1 });

      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0]!.to && "value" in sink.messages[0]!.to! ? sink.messages[0]!.to!.value[0]!.address : undefined).toBe("system@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("retries a transient failure with backoff and does not resend before it's due", async () => {
    const sink = await startSmtpSink();
    const port = sink.port;
    await sink.close(); // connection now refused
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, connectionTimeout: 2000 });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      const before = new Date();
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(1);
      expect(row!.lastError).toBeTruthy();
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(before.getTime());

      // Same clock, immediately after: the backoff window hasn't elapsed, so nothing is due yet.
      const second = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(second).toEqual({ sent: 0, retried: 0, failed: 0 });
    } finally {
      await transport.close();
    }
  }, 15000);

  it("fails immediately on a permanent 5xx response", async () => {
    const sink = await startSmtpSink({ rejectRcpt: 550 });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("failed");
      expect(row!.attempts).toBe(1);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("concurrent sendDue calls never deliver the same message twice", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: Array.from({ length: 20 }, (_, i) => ({ email: `r${i}@example.com`, substitutions: {} })) },
        internalDomains,
      );

      const [a, b] = await Promise.all([
        sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], batchSize: 50 }),
        sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], batchSize: 50 }),
      ]);

      expect(a.sent + b.sent).toBe(20);
      expect(sink.messages).toHaveLength(20);
      const recipients = sink.messages.map((m) => (m.to && "value" in m.to ? m.to.value[0]!.address : undefined));
      expect(new Set(recipients).size).toBe(20);
    } finally {
      await transport.close();
      await sink.close();
    }
  });
});
