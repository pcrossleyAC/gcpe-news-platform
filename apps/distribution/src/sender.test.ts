import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import nodemailer, { type Transporter } from "nodemailer";
import { sql } from "drizzle-orm";
import { dbClock, type TestDatabase } from "@gcpe/db-kit";
import { createBatch } from "./messages";
import { messages } from "./db/schema";
import { createDistributionTestDb, sampleMessageRequest } from "../test/helpers";
import { startSmtpSink } from "../test/smtp-sink";
import { defaultSendLockMs, sendDue, startSender, truncateError } from "./sender";

const internalDomains = ["gov.bc.ca"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("defaultSendLockMs", () => {
  // P2-R25 item 1: a message's worst case is its send *plus* a transport.verify() (a
  // connection-level error triggers one per message), so both count toward the lock.
  it("is batchSize * (perMessageMs + verifyTimeoutMs), plus a 30s margin", () => {
    expect(defaultSendLockMs({ batchSize: 50, perMessageMs: 50_000, verifyTimeoutMs: 10_000 })).toBe(50 * 60_000 + 30_000);
    expect(defaultSendLockMs({ batchSize: 1, perMessageMs: 1000, verifyTimeoutMs: 500 })).toBe(1 * 1500 + 30_000);
  });
});

describe("truncateError", () => {
  it("truncates by Unicode code point, not UTF-16 code unit", () => {
    // Each "💥" is one code point but two UTF-16 units; a naive `.slice(0, 500)` would cut
    // this 501-emoji string after 250 complete code points (500 units / 2), not 500.
    const message = "💥".repeat(501);
    const truncated = truncateError(message);
    expect(Array.from(truncated)).toHaveLength(500); // naive string.slice(0, 500) would keep only 250 complete emoji
    expect(truncated).toBe("💥".repeat(500));
  });

  it("leaves a short message untouched", () => {
    expect(truncateError("boom")).toBe("boom");
  });
});

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
      // No redirect configured: there's no "original" recipient distinct from the real one.
      expect(rows.every((r) => r.originalRecipient === null)).toBe(true);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("sends a batch's attachments with every message, with their filenames and content types", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes");
      await createBatch(
        tdb.db,
        "app",
        {
          ...sampleMessageRequest,
          attachments: [
            { filename: "DRAFT-abc.pdf", contentType: "application/pdf", contentBase64: pdfBytes.toString("base64") },
            { filename: "DRAFT-abc.txt", contentType: "text/plain", contentBase64: Buffer.from("Plain text version").toString("base64") },
          ],
        },
        internalDomains,
      );
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });

      expect(result).toEqual({ sent: 2, retried: 0, failed: 0 });
      expect(sink.messages).toHaveLength(2);
      for (const m of sink.messages) {
        expect(m.attachments.map((a) => [a.filename, a.contentType])).toEqual([
          ["DRAFT-abc.pdf", "application/pdf"],
          ["DRAFT-abc.txt", "text/plain"],
        ]);
        expect(m.attachments[0]!.content.equals(pdfBytes)).toBe(true);
        expect(m.attachments[1]!.content.toString()).toBe("Plain text version");
      }
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
      // Redirected copies say who they were for, so a tester can tell identical-looking copies apart.
      const subjects = sink.messages.map((m) => m.subject ?? "").sort();
      expect(subjects.every((s, i) => s.startsWith(`[to: ${originalTos[i]}] `))).toBe(true);

      const rows = await tdb.db.select().from(messages);
      expect(rows.map((r) => r.originalRecipient).sort()).toEqual(["alex.example@gov.bc.ca", "sam.example@example.com"]);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("drops any caller-supplied X-Original-To header, case-insensitively, before adding its own", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, headers: { "x-original-to": "attacker@evil.com" }, recipients: [{ email: "victim@example.com", substitutions: {} }] },
        internalDomains,
      );
      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: ["qa@example.com"] });

      expect(sink.messages).toHaveLength(1);
      const originalToLines = sink.messages[0]!.headerLines.filter((h) => h.key === "x-original-to");
      expect(originalToLines).toHaveLength(1);
      expect(originalToLines[0]!.line).toBe("X-Original-To: victim@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("sets the Message-ID from the row id and the configured domain, and records it on the row", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
      await sendDue({ db: tdb.db, transport, from: "news@example.com", messageIdDomain: "example.test", redirectTo: [] });

      const [row] = await tdb.db.select().from(messages);
      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0]!.messageId).toBe(`<${row!.id}@example.test>`);
      expect(row!.messageId).toBe(`<${row!.id}@example.test>`);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("keeps the same Message-ID across a transient failure and the retry that succeeds", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "retry@example.com", substitutions: {} }] }, internalDomains);
    let attempt = 0;
    const sentMessageIds: (string | undefined)[] = [];
    const stubTransport = {
      sendMail: async (mail: { messageId?: string }) => {
        sentMessageIds.push(mail.messageId);
        attempt++;
        if (attempt === 1) {
          throw Object.assign(new Error("Message failed: 452 too many recipients"), { code: "EMESSAGE", command: "DATA", responseCode: 452 });
        }
      },
    } as unknown as Transporter;

    let simulatedNow = (await dbClock(tdb.db)).getTime();
    const first = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", messageIdDomain: "example.test", redirectTo: [], now: () => new Date(simulatedNow) });
    expect(first).toEqual({ sent: 0, retried: 1, failed: 0 });

    const [rowAfterFirst] = await tdb.db.select().from(messages);
    expect(rowAfterFirst!.status).toBe("pending");
    simulatedNow = rowAfterFirst!.nextAttemptAt.getTime() + 1000; // just past due for the retry

    const second = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", messageIdDomain: "example.test", redirectTo: [], now: () => new Date(simulatedNow) });
    expect(second).toEqual({ sent: 1, retried: 0, failed: 0 });

    expect(sentMessageIds).toHaveLength(2);
    expect(sentMessageIds[0]).toBeTruthy();
    expect(sentMessageIds[0]).toBe(sentMessageIds[1]);

    const [rowAfterSecond] = await tdb.db.select().from(messages);
    expect(rowAfterSecond!.status).toBe("sent");
    expect(rowAfterSecond!.messageId).toBe(sentMessageIds[0]);
  });

  it("the request's own Reply-To wins over MAIL_REPLY_TO", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, replyTo: "batch-reply@example.com", recipients: [{ email: "x@example.com", substitutions: {} }] },
        internalDomains,
      );
      await sendDue({ db: tdb.db, transport, from: "news@example.com", replyTo: "fallback-reply@example.com", redirectTo: [] });

      expect(sink.messages).toHaveLength(1);
      const replyTo = sink.messages[0]!.replyTo;
      expect(replyTo?.value[0]?.address).toBe("batch-reply@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("falls back to MAIL_REPLY_TO when the request carries none", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
      await sendDue({ db: tdb.db, transport, from: "news@example.com", replyTo: "fallback-reply@example.com", redirectTo: [] });

      expect(sink.messages).toHaveLength(1);
      const replyTo = sink.messages[0]!.replyTo;
      expect(replyTo?.value[0]?.address).toBe("fallback-reply@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("sets no Reply-To header when neither the request nor MAIL_REPLY_TO is set", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });

      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0]!.replyTo).toBeUndefined();
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("keeps the Message-ID and Reply-To unchanged in redirect mode", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, replyTo: "batch-reply@example.com", recipients: [{ email: "victim@example.com", substitutions: {} }] },
        internalDomains,
      );
      await sendDue({ db: tdb.db, transport, from: "news@example.com", messageIdDomain: "example.test", redirectTo: ["qa@example.com"] });

      const [row] = await tdb.db.select().from(messages);
      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0]!.messageId).toBe(`<${row!.id}@example.test>`);
      expect(sink.messages[0]!.replyTo?.value[0]?.address).toBe("batch-reply@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("sends higher-priority messages first within a single claimed batch", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, priority: "digest", recipients: Array.from({ length: 5 }, (_, i) => ({ email: `digest${i}@example.com`, substitutions: {} })) },
        internalDomains,
      );
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "system@example.com", substitutions: {} }] }, internalDomains);

      // Default batchSize: all 6 messages are claimed in the same call, so send order within
      // that one claim is the thing under test (not which batch gets claimed at all).
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });

      expect(result).toEqual({ sent: 6, retried: 0, failed: 0 });
      expect(sink.messages).toHaveLength(6);
      const firstTo = sink.messages[0]!.to && "value" in sink.messages[0]!.to! ? sink.messages[0]!.to!.value[0]!.address : undefined;
      expect(firstTo).toBe("system@example.com");
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("retries a connection-refused (config-stage) failure with backoff and does not resend before it's due, without spending an attempt", async () => {
    const sink = await startSmtpSink();
    const port = sink.port;
    await sink.close(); // connection now refused
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, connectionTimeout: 2000 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      const before = new Date();
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      // I2: connection-refused is a config/connection-stage error (nodemailer tags it
      // `command: "CONN"`), so this must not spend an attempt — an outage must never be able
      // to drain the queue to failed via MAX_ATTEMPTS.
      expect(row!.attempts).toBe(0);
      expect(row!.lastError).toBeTruthy();
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(before.getTime());

      // Same clock, immediately after: the backoff window hasn't elapsed, so nothing is due yet.
      const second = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(second).toEqual({ sent: 0, retried: 0, failed: 0 });
    } finally {
      errorSpy.mockRestore();
      await transport.close();
    }
  }, 15000);

  it("fails immediately on a permanent RCPT TO rejection (5xx)", async () => {
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

  // R24: MAIL FROM and AUTH* are never ambiguous — the envelope sender and the transport's
  // configured credentials are the same for every message a run sends, so a rejection at
  // either stage can't be specific to whichever message happened to be claimed first. This is
  // the gap the R1 wave's own doc comment flagged: a transport with no `auth` block at all
  // can't have "needs auth but none configured" exercised by transport.verify() (verify()
  // only attempts AUTH when the transport is configured with credentials), which used to
  // misclassify this exact scenario as the message's fault — spending an attempt per message
  // and, over enough runs, draining the whole queue to failed via MAX_ATTEMPTS (the original
  // I2 bug, back for this one misconfiguration). Classified directly as sender-level now, with
  // no verify() call at all: deferred, no attempt spent, run stopped, deferrals escalating —
  // proven across 6+ runs (more than MAX_ATTEMPTS) to show it can never drain to failed.
  it("treats 'auth required but none configured' (530 at MAIL FROM) as a sender-level config error — deferred without spending an attempt, across 6+ runs, no verify() needed", async () => {
    const sink = await startSmtpSink({ requireAuth: true });
    // No `auth` configured: the client never sends AUTH, so the server's 530 fires at MAIL FROM.
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      let simulatedNow = (await dbClock(tdb.db)).getTime();
      for (let run = 0; run < 6; run++) {
        const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(simulatedNow) });
        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        const [row] = await tdb.db.select().from(messages);
        // Advance well past this run's deferral backoff so the message is due again.
        simulatedNow = row!.nextAttemptAt.getTime() + 1000;
      }

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(6);

      const serverDownCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[distribution] SMTP server unavailable/misconfigured:"));
      expect(serverDownCalls.length).toBeGreaterThan(0);
      const transientCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("transient error:"));
      expect(transientCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  }, 15000);

  it("retries (does not fail, does not spend an attempt) when authentication is rejected (535 wrong password) — verify() fails the same way, so this stays a server/config problem", async () => {
    const sink = await startSmtpSink({ requireAuth: true });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true, auth: { user: "svc", pass: "wrong" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(1);
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[distribution] SMTP server unavailable/misconfigured:"));
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  });

  // I2/R1: the bug this fixes — config/connection-stage errors used to count toward
  // MAX_ATTEMPTS (5), so a ~15-minute SMTP outage (a handful of 2s-apart sendDue calls) would
  // drain the queue to permanently failed. Running the same CONN-error outage across 6+ calls
  // (more than MAX_ATTEMPTS) must leave the message pending with attempts still at 0 (deferrals
  // climbing instead), never failed. The stub transport has no `verify` method at all, which
  // `isTransportHealthy` treats the same as a verify failure (the safer default) — exactly like
  // a genuinely unreachable server.
  it("never fails, and never spends an attempt, across 6+ runs of a connection-stage SMTP outage (deferrals climb instead)", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2525"), { code: "ECONNREFUSED", command: "CONN" });
      },
    } as unknown as Transporter;
    try {
      let simulatedNow = (await dbClock(tdb.db)).getTime();
      for (let run = 0; run < 6; run++) {
        const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(simulatedNow) });
        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        // Advance well past this call's backoff so the message is due again on the next run,
        // simulating repeated outage checks rather than one that never comes due.
        simulatedNow += 3_600_000;
      }

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(6);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[distribution] SMTP server unavailable/misconfigured:"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  // R1: the literal "server down" case, with more than one claimed row, spelled out — attempts
  // stays 0, deferrals becomes 1, and the run stops (the second row is released untouched
  // rather than also being attempted against a server that's still down).
  it("a genuinely down server (verify fails): attempts 0, deferrals 1, and the run stops before reaching the second row", async () => {
    // Two separate batches at different priorities (rather than two recipients in one batch)
    // so claim order is deterministic — `priority DESC, next_attempt_at, id` would otherwise
    // break the tie between same-priority, same-batch rows on `id`, a random UUID, making
    // "first"/"second" below a coin flip instead of a guarantee.
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "first@example.com", substitutions: {} }] }, internalDomains);
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "digest", recipients: [{ email: "second@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "CONN" });
      },
      // No real network reachability at all: verify() fails too, exactly like a real outage.
      verify: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    } as unknown as Transporter;
    try {
      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const rows = await tdb.db.select().from(messages);
      const first = rows.find((r) => r.email === "first@example.com")!;
      const second = rows.find((r) => r.email === "second@example.com")!;
      expect(first.status).toBe("pending");
      expect(first.attempts).toBe(0);
      expect(first.deferrals).toBe(1);
      expect(first.lockedUntil).toBeNull();
      // Never reached at all — the run stopped after the first row's config-class deferral.
      expect(second.status).toBe("pending");
      expect(second.attempts).toBe(0);
      expect(second.deferrals).toBe(0);
      expect(second.lastError).toBeNull();
      expect(second.lockedUntil).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // R1(c): deferrals (unlike attempts) escalate their own backoff, capped at 1h — each
  // successive deferral on the same still-down server should back off further than the last
  // (until the cap).
  it("escalates the deferral backoff across successive config-class deferrals, capped at 1h", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "escalate@example.com", substitutions: {} }] }, internalDomains);
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "CONN" });
      },
    } as unknown as Transporter;

    let simulatedNow = (await dbClock(tdb.db)).getTime();
    const deltas: number[] = [];
    for (let run = 0; run < 4; run++) {
      const before = simulatedNow;
      await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(simulatedNow) });
      const [row] = await tdb.db.select().from(messages);
      deltas.push(row!.nextAttemptAt.getTime() - before);
      expect(row!.deferrals).toBe(run + 1);
      simulatedNow = row!.nextAttemptAt.getTime() + 1000; // just past due for the next run
    }

    // Strictly increasing until the 1h cap is reached.
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]!).toBeGreaterThanOrEqual(deltas[i - 1]!);
    }
    expect(Math.max(...deltas)).toBeLessThanOrEqual(3_600_000);
    expect(deltas.some((d) => d > deltas[0]!)).toBe(true);
  });

  // R1(a): the actual bug this fixes — a poison message (one specific recipient whose send
  // stalls/resets mid-DATA, which nodemailer tags `command: "CONN"`, indistinguishable by
  // command alone from a real outage) must not stop the rest of the batch from sending. A real
  // smtp-server stalls forever on DATA only for a body containing a marker; transport.verify()
  // against that same (otherwise healthy) server succeeds, so the poison message is treated as
  // a normal transient error (spends an attempt) while a lower-priority, healthy message in the
  // same run still gets sent.
  it("a poison message (verify succeeds) spends an attempt and does not stop the run — a lower-priority message in the same batch still sends", async () => {
    const { SMTPServer } = await import("smtp-server");
    const { simpleParser } = await import("mailparser");
    const poisonMarker = "POISON-MARKER";
    const delivered: string[] = [];
    const server = new SMTPServer({
      disabledCommands: ["STARTTLS", "AUTH"],
      onData(stream, _session, cb) {
        simpleParser(stream).then((m) => {
          const text = (m.text ?? "") + (m.html ?? "");
          if (text.includes(poisonMarker)) return; // never call cb(): stalls until socketTimeout
          delivered.push(m.subject ?? "");
          cb();
        }, cb);
      },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.server.address() as { port: number }).port;
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true, socketTimeout: 500 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(
        tdb.db,
        "app",
        {
          ...sampleMessageRequest,
          priority: "system",
          subject: "Poison batch",
          text: `Hi {{name}}, ${poisonMarker}`,
          recipients: [{ email: "poison@example.com", substitutions: { name: "P" } }],
        },
        internalDomains,
      );
      await createBatch(
        tdb.db,
        "app",
        {
          ...sampleMessageRequest,
          priority: "digest",
          subject: "Healthy batch",
          text: "Hi {{name}}, ordinary clinic update",
          recipients: [{ email: "healthy@example.com", substitutions: { name: "H" } }],
        },
        internalDomains,
      );

      // "system" claims before "digest", so the poison message is hit first in this one call.
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
      expect(delivered).toEqual(["Healthy batch"]);

      const rows = await tdb.db.select().from(messages);
      const poisonRow = rows.find((r) => r.email === "poison@example.com")!;
      const healthyRow = rows.find((r) => r.email === "healthy@example.com")!;
      expect(poisonRow.status).toBe("pending");
      expect(poisonRow.attempts).toBe(1);
      expect(poisonRow.deferrals).toBe(0);
      expect(poisonRow.lastError).toBeTruthy();
      expect(healthyRow.status).toBe("sent");

      const transientCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes(`message ${poisonRow.id} transient error:`));
      expect(transientCalls).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10000);

  // R1(b) backstop: whatever error class a message keeps hitting, once it's been pending
  // longer than maxMessageAgeMs it's marked failed and logged — the net under every other
  // retry/defer path. Uses a plain (non-config, non-permanent) transient error so this is
  // clearly the backstop acting, not MAX_ATTEMPTS or a permanent rejection.
  it("the age backstop fails and logs a message that's been pending too long, regardless of error class", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "stale@example.com", substitutions: {} }] }, internalDomains);
    const stubTransport = {
      sendMail: async () => {
        throw new Error("transient hiccup");
      },
    } as unknown as Transporter;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // maxMessageAgeMs: 0 — any elapsed time at all (there's always some, between the batch's
      // created_at and this call's `now`) is "too long", without needing to actually wait or
      // fabricate a backdated created_at.
      const result = await sendDue({
        db: tdb.db,
        transport: stubTransport,
        from: "news@example.com",
        redirectTo: [],
        maxMessageAgeMs: 0,
      });
      expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("failed");
      expect(row!.attempts).toBe(1);
      expect(row!.lastError).toContain("transient hiccup");

      const backstopCalls = errorSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].startsWith(`[distribution] message ${row!.id} failed after 1 attempts`) && c[0].includes("age backstop"),
      );
      expect(backstopCalls).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // I2: a genuine permanent recipient rejection (RCPT TO 5xx) is unaffected by the config-error
  // carve-out above — it must still fail immediately, attempt-for-attempt as before.
  it("still fails immediately on a permanent RCPT TO rejection even though config errors no longer do", async () => {
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

  // I5: a message going failed was otherwise silent — nothing else notices mail that stopped
  // being delivered.
  it("logs once (console.error) when a message goes failed", async () => {
    const sink = await startSmtpSink({ rejectRcpt: 550 });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      const [row] = await tdb.db.select().from(messages);

      const failureCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith(`[distribution] message ${row!.id} failed after 1 attempts:`));
      expect(failureCalls).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  });

  // P2-R26: SKIP LOCKED, not just the lock predicate, keeps a claim from *waiting* on a row
  // another transaction holds — the first message in claim order here — instead of sending the rest.
  it("does not wait on a message row locked by another transaction (FOR UPDATE SKIP LOCKED)", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "locked@example.com", substitutions: {} }] }, internalDomains);
    await createBatch(
      tdb.db,
      "app",
      { ...sampleMessageRequest, priority: "digest", recipients: [{ email: "free1@example.com", substitutions: {} }, { email: "free2@example.com", substitutions: {} }] },
      internalDomains,
    );
    const sentTo: string[] = [];
    const stubTransport = {
      sendMail: async (mail: { to: string[] }) => {
        sentTo.push(...mail.to);
        return {};
      },
    } as unknown as Transporter;
    const locker = await tdb.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM messages WHERE email = 'locked@example.com' FOR UPDATE");
    try {
      const result = await Promise.race([
        sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sendDue waited on the locked row instead of skipping it")), 5000)),
      ]);
      expect(result).toEqual({ sent: 2, retried: 0, failed: 0 });
      expect(sentTo.sort()).toEqual(["free1@example.com", "free2@example.com"]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 7000);

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

  it("a slow-sink run that outlives a short lock still delivers every message exactly once to a later run", async () => {
    // Shaped like the reproduced bug: a slow SMTP server plus a worker whose claim lock is too
    // short for the batch lets a second worker reclaim rows while the first is still mid-batch.
    const sink = await startSmtpSink({ delayMs: 150 });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: Array.from({ length: 6 }, (_, i) => ({ email: `m${i}@example.com`, substitutions: {} })) },
        internalDomains,
      );

      // The first run's lock (300ms) is far shorter than 6 messages at 150ms each (~900ms) —
      // exactly the "lock expires mid-batch" scenario that used to double-send. It is started
      // without awaiting so the second run below genuinely overlaps it instead of running
      // strictly after it finishes. lockMarginMs is set well below lockMs (sendDue requires
      // lockMs > lockMarginMs) and far below the default (perMessageMs, tens of seconds) so the
      // margin check doesn't trip before the very first message of this short-lived lock.
      const firstRun = sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], batchSize: 6, lockMs: 300, lockMarginMs: 100 });
      await sleep(320); // past the first run's lock, while it may still be mid-batch
      const secondRun = sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], batchSize: 6 }); // generous default lock
      await Promise.all([firstRun, secondRun]);

      expect(sink.messages).toHaveLength(6);
      const recipients = sink.messages.map((m) => (m.to && "value" in m.to ? m.to.value[0]!.address : undefined));
      expect(new Set(recipients).size).toBe(6);

      const rows = await tdb.db.select().from(messages);
      expect(rows.every((r) => r.status === "sent")).toBe(true);
    } finally {
      await transport.close();
      await sink.close();
    }
  }, 15000);

  it("stops starting new sends once stopRequested() returns true, leaving later rows untouched", async () => {
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: [{ email: "a@example.com", substitutions: {} }, { email: "b@example.com", substitutions: {} }, { email: "c@example.com", substitutions: {} }] },
        internalDomains,
      );

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], stopRequested: () => sink.messages.length >= 1 });

      expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
      expect(sink.messages).toHaveLength(1);
      const rows = await tdb.db.select().from(messages);
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("startSender's stop() awaits the in-flight run and claims no further work afterward", async () => {
    const sink = await startSmtpSink({ delayMs: 50 });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: Array.from({ length: 5 }, (_, i) => ({ email: `s${i}@example.com`, substitutions: {} })) },
        internalDomains,
      );

      const stop = startSender({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], intervalMs: 20 });
      await sleep(30); // let the first tick claim the batch and start sending
      await stop(); // must await that in-flight sendDue call fully

      const afterStopCount = sink.messages.length;
      await sleep(250); // long enough for a would-be next tick to have fired and sent more
      expect(sink.messages.length).toBe(afterStopCount);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  // P2-R25 item 3: an outage deferral stops the run and releases the rest of its claim — so
  // without pacing, the very next tick (2s later in production) claims the next row and hits
  // the still-down server again, every tick, for as long as the outage lasts.
  it("after an outage deferral, startSender pauses for that row's backoff instead of retrying the server every tick, then resumes", async () => {
    await createBatch(
      tdb.db,
      "app",
      { ...sampleMessageRequest, recipients: Array.from({ length: 5 }, (_, i) => ({ email: `outage${i}@example.com`, substitutions: {} })) },
      internalDomains,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let down = true;
    let sendCalls = 0;
    const stubTransport = {
      sendMail: async () => {
        sendCalls++;
        if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "CONN" });
        return {};
      },
      verify: async () => {
        if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return true;
      },
    } as unknown as Transporter;
    let fakeMonotonicMs = 0;
    const stop = startSender({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], intervalMs: 10, cooldownClock: () => fakeMonotonicMs });
    try {
      await vi.waitFor(() => expect(sendCalls).toBe(1));
      await sleep(200); // ~20 ticks: without pacing, each would claim and try another row
      expect(sendCalls).toBe(1);

      // The first deferral's backoff (60s) elapses and the server is back: sending resumes.
      down = false;
      fakeMonotonicMs += 60_000;
      await vi.waitFor(async () => {
        const rows = await tdb.db.select().from(messages);
        expect(rows.filter((r) => r.status === "sent")).toHaveLength(4); // the deferred row isn't due for 60s yet
      });
      expect(sendCalls).toBe(5);
    } finally {
      await stop();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // P2-R27 item 2: the pause is capped (default 5 min) so recovery after a long outage isn't
  // gated on an escalated 1h row backoff.
  it("caps the outage pause at outageCooldownMaxMs (default 5 min), even when the deferred row's own backoff is 1h", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "old-outage@example.com", substitutions: {} }] }, internalDomains);
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "digest", recipients: [{ email: "waiting@example.com", substitutions: {} }] }, internalDomains);
    // Already deferred 6 times: its next deferral backs off by the full 1h cap.
    await tdb.db.execute(sql`UPDATE messages SET deferrals = 6 WHERE email = 'old-outage@example.com'`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let down = true;
    let sendCalls = 0;
    const stubTransport = {
      sendMail: async () => {
        sendCalls++;
        if (down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", command: "CONN" });
        return {};
      },
      verify: async () => {
        if (down) throw new Error("connect ECONNREFUSED");
        return true;
      },
    } as unknown as Transporter;
    let fakeMonotonicMs = 0;
    const stop = startSender({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], intervalMs: 10, cooldownClock: () => fakeMonotonicMs });
    try {
      await vi.waitFor(() => expect(sendCalls).toBe(1));
      down = false;
      fakeMonotonicMs += 300_000 - 1;
      await sleep(100);
      expect(sendCalls).toBe(1); // still paused just short of 5 min
      fakeMonotonicMs += 1;
      // The sender has to finish its paused loop iteration, re-verify the transport and send two
      // rows; on a slow CI runner that has taken just over vi.waitFor's 1 s default (flaked 3x on
      // 2026-10-05). The pause assertion above is what this test is about, so give the drain room.
      await vi.waitFor(
        async () => {
          const rows = await tdb.db.select().from(messages);
          expect(rows.find((r) => r.email === "waiting@example.com")!.status).toBe("sent");
        },
        { timeout: 10_000 },
      );
    } finally {
      await stop();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("skips rows whose ownership is stolen before their turn to send (the per-message re-assert)", async () => {
    // A stub transport (no real SMTP) so the "another worker reclaimed this row" race can be
    // simulated deterministically: its 2nd call reaches into the DB directly and reclaims every
    // still-pending row, exactly as if a second worker's claim had just run.
    await createBatch(
      tdb.db,
      "app",
      { ...sampleMessageRequest, recipients: Array.from({ length: 6 }, (_, i) => ({ email: `o${i}@example.com`, substitutions: {} })) },
      internalDomains,
    );

    let calls = 0;
    const stubTransport = {
      sendMail: async () => {
        calls++;
        if (calls === 2) {
          await tdb.db.execute(sql`UPDATE messages SET locked_until = now() + interval '1 hour' WHERE status = 'pending'`);
        }
        return {};
      },
    } as unknown as Transporter;

    // lockMs well above the default lockMarginMs (perMessageMs) so the stop/margin check never
    // fires — only the re-assert is under test here.
    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], batchSize: 6, lockMs: 120_000 });

    // Row 1 sends and is counted; row 2's send happens but the steal lands before its terminal
    // write, so it's silently not counted; rows 3-6 are skipped by the re-assert before ever
    // reaching sendMail at all.
    expect(calls).toBe(2);
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
  });

  it("releases rows it never reached so another run can claim them immediately, not after the full lock expires", async () => {
    await createBatch(
      tdb.db,
      "app",
      { ...sampleMessageRequest, recipients: Array.from({ length: 5 }, (_, i) => ({ email: `u${i}@example.com`, substitutions: {} })) },
      internalDomains,
    );

    let stopNow = false;
    const sentTo: unknown[] = [];
    const stubTransport = {
      sendMail: async (mail: { to: unknown[] }) => {
        sentTo.push(mail.to);
        stopNow = true; // request a stop once the first message is underway
        return {};
      },
    } as unknown as Transporter;

    const result = await sendDue({
      db: tdb.db,
      transport: stubTransport,
      from: "news@example.com",
      redirectTo: [],
      batchSize: 5,
      lockMs: 120_000, // 2 minutes — if the 4 unreached rows weren't released, they'd stay
      // locked long after this test (and this whole file) finishes.
      stopRequested: () => stopNow,
    });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(sentTo).toHaveLength(1);

    // Immediately — no waiting for the first run's lock to expire — a second run with a real
    // sink should be able to claim and send the other 4.
    const sink = await startSmtpSink();
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    try {
      const second = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(second).toEqual({ sent: 4, retried: 0, failed: 0 });
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  it("rejects a lockMs that isn't greater than lockMarginMs, at sendDue's entry", async () => {
    await expect(
      sendDue({ db: tdb.db, transport: {} as unknown as Transporter, from: "news@example.com", redirectTo: [], lockMs: 1000, lockMarginMs: 1000 }),
    ).rejects.toThrow(/lockMs.*lockMarginMs/);
  });

  it("defaults the stop margin to perMessageMs + verifyTimeoutMs, not a fixed 30s, so a short-but-valid lock for a fast batch still sends", async () => {
    // lockMs (1000ms) is smaller than the fixed 30s margin this loop's check used to use — a
    // fixed 30s default would have tripped it before the very first row, sending nothing. With
    // the margin defaulted off one message's worst case (200ms send + 300ms verify) instead,
    // there's room for one fast send.
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const stubTransport = { sendMail: async () => ({}) } as unknown as Transporter;

    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], batchSize: 1, perMessageMs: 200, verifyTimeoutMs: 300, lockMs: 1000 });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
  });

  // P2-R25 item 1: the stop margin must cover a message's verify() too — otherwise a run could
  // start a message whose send + verify outlasts its own lock.
  it("counts verifyTimeoutMs in the default stop margin, rejecting a lock that only covers the send", async () => {
    await expect(
      sendDue({ db: tdb.db, transport: {} as unknown as Transporter, from: "news@example.com", redirectTo: [], perMessageMs: 200, verifyTimeoutMs: 900, lockMs: 1000 }),
    ).rejects.toThrow(/lockMs \(1000\) must be greater than lockMarginMs \(1100\)/);
  });

  // P2-R25 item 1 (reproduced): a connection-level error makes the run wait on
  // transport.verify() for up to verifyTimeoutMs. If the default lock only budgeted the send,
  // another replica polling during that wait would find the lock expired and send the same
  // message again.
  it("sizes the default lock to cover a slow verify(): another run can't re-claim the row while this run waits on verify", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "verify@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let sends = 0;
    let verifies = 0;
    let verifyStarted!: () => void;
    let finishVerify!: () => void;
    const firstVerifyStarted = new Promise<void>((r) => (verifyStarted = r));
    const stubTransport = {
      sendMail: async () => {
        sends++;
        throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" });
      },
      // The first run's verify() hangs (a slow server) until released; any later one answers at once.
      verify: () => {
        verifies++;
        if (verifies > 1) return Promise.resolve(true);
        verifyStarted();
        return new Promise((r) => (finishVerify = () => r(true)));
      },
    } as unknown as Transporter;
    const timing = { batchSize: 1, perMessageMs: 1_000, verifyTimeoutMs: 60_000 };
    try {
      const first = sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], ...timing });
      // Fail fast (rather than hang) if the first run ends without ever reaching verify().
      await Promise.race([firstVerifyStarted, first.then(() => Promise.reject(new Error("first run finished without reaching verify()")))]);
      // A second replica polls 45s into the first run's verify (simulated with a test clock):
      // past a send-only lock (1s + 30s), well inside one that also budgets the 60s verify.
      const t = (await dbClock(tdb.db)).getTime();
      const second = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], ...timing, now: () => new Date(t + 45_000) });
      expect(second).toEqual({ sent: 0, retried: 0, failed: 0 });
      expect(sends).toBe(1);

      finishVerify();
      expect(await first).toEqual({ sent: 0, retried: 1, failed: 0 });
    } finally {
      finishVerify?.();
      errorSpy.mockRestore();
    }
  });

  it("rejects a lockMs that isn't greater than lockMarginMs, at startSender's entry (synchronously, before the first tick)", () => {
    expect(() => startSender({ db: tdb.db, transport: {} as unknown as Transporter, from: "news@example.com", redirectTo: [], lockMs: 1000, lockMarginMs: 2000 })).toThrow(
      /lockMs.*lockMarginMs/,
    );
  });

  it("retries and logs a configuration error for an EHLO/greeting-stage failure", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stubTransport = {
        sendMail: async () => {
          throw Object.assign(new Error("Server terminates connection"), { code: "ECONNECTION", command: "EHLO" });
        },
      } as unknown as Transporter;

      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[distribution] SMTP server unavailable/misconfigured:"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  // P2-R25 item 4 follow-on: with the pool's re-queue off (transport.ts maxRequeues: 0), a
  // server that accepts TCP and then drops it before its greeting fails sendMail with
  // code ECONNECTION and *no* `command` — the same outage-or-poison ambiguity as a CONN error,
  // so it must go through the same verify() check rather than spend an attempt.
  it("treats an ECONNECTION error with no command (connection closed before the greeting) as connection-level: verify() fails, so it's deferred without spending an attempt", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("Reached maximum number of retries after connection was closed"), { code: "ECONNECTION" });
      },
      verify: async () => {
        throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION", command: "CONN" });
      },
    } as unknown as Transporter;
    try {
      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
      const [row] = await tdb.db.select().from(messages);
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // P2-R27 item 3: a flapping server — the connection is dropped before the greeting (a
  // command-less ECONNECTION: nothing of the message was sent, so it can't be the message's
  // fault) yet verify() finds the server up. Deferred without spending an attempt, with an
  // escalating backoff, across more runs than MAX_ATTEMPTS; the 24h age backstop bounds it.
  it("a flapping server (pre-greeting drop, verify healthy) defers without spending an attempt, across more than MAX_ATTEMPTS runs", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "flap@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("Reached maximum number of retries after connection was closed"), { code: "ECONNECTION" });
      },
      verify: async () => true,
    } as unknown as Transporter;
    try {
      let simulatedNow = (await dbClock(tdb.db)).getTime();
      const deltas: number[] = [];
      for (let run = 0; run < 6; run++) {
        const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(simulatedNow) });
        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        const [row] = await tdb.db.select().from(messages);
        deltas.push(row!.nextAttemptAt.getTime() - simulatedNow);
        simulatedNow = row!.nextAttemptAt.getTime() + 1000;
      }
      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(0);
      expect(row!.deferrals).toBe(6);
      expect(deltas[1]!).toBeGreaterThan(deltas[0]!); // escalating
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a flapping server's pre-greeting drop doesn't stop the run: verify says the server is up, so later rows still send", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "system", recipients: [{ email: "dropped@example.com", substitutions: {} }] }, internalDomains);
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, priority: "digest", recipients: [{ email: "fine@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async (mail: { to: string[] }) => {
        if (mail.to[0] === "dropped@example.com") throw Object.assign(new Error("Connection closed"), { code: "ECONNECTION" });
        return {};
      },
      verify: async () => true,
    } as unknown as Transporter;
    try {
      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
      const rows = await tdb.db.select().from(messages);
      const dropped = rows.find((r) => r.email === "dropped@example.com")!;
      expect(dropped.attempts).toBe(0);
      expect(dropped.deferrals).toBe(1);
      expect(rows.find((r) => r.email === "fine@example.com")!.status).toBe("sent");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("leaves a DATA-stage 5xx (e.g. a server-side size rejection mid-transfer) to retry, not fail", async () => {
    // Deliberate: unlike the MAIL-FROM-stage size check above (which never reaches the server),
    // a DATA-stage rejection means the message was already (partly) accepted — treating it as
    // permanent would drop mail outright on what might be a transient server-side limit, which
    // is worse than a few retries.
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("Message failed: 552 message too large"), { code: "EMESSAGE", command: "DATA", responseCode: 552 });
      },
    } as unknown as Transporter;

    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [] });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

    const [row] = await tdb.db.select().from(messages);
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
  });
});
