import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import nodemailer, { type Transporter } from "nodemailer";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createBatch } from "./messages";
import { messages } from "./db/schema";
import { createDistributionTestDb, sampleMessageRequest } from "../test/helpers";
import { startSmtpSink } from "../test/smtp-sink";
import { defaultSendLockMs, sendDue, startSender, truncateError } from "./sender";

const internalDomains = ["gov.bc.ca"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("defaultSendLockMs", () => {
  it("is batchSize * perMessageMs, plus a 30s margin", () => {
    expect(defaultSendLockMs({ batchSize: 50, perMessageMs: 50_000 })).toBe(50 * 50_000 + 30_000);
    expect(defaultSendLockMs({ batchSize: 1, perMessageMs: 1000 })).toBe(1 * 1000 + 30_000);
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

  it("retries (does not fail, does not spend an attempt) when the server demands authentication that was never attempted (530), logging a configuration error once and stopping the run after the first one", async () => {
    const sink = await startSmtpSink({ requireAuth: true });
    // No `auth` configured: the client never sends AUTH, so the server's 530 fires at MAIL FROM.
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: [{ email: "a@example.com", substitutions: {} }, { email: "b@example.com", substitutions: {} }, { email: "c@example.com", substitutions: {} }] },
        internalDomains,
      );

      // I2: a config-stage error stops the run after the first row — the other 2 recipients
      // are released, untouched, rather than also being attempted (and retried) against a
      // server that's still misconfigured.
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [] });
      expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

      const rows = await tdb.db.select().from(messages);
      expect(rows.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
      expect(rows.filter((r) => r.lockedUntil === null)).toHaveLength(3);

      const configErrorCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[distribution] SMTP configuration error:"));
      expect(configErrorCalls).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  });

  it("retries (does not fail, does not spend an attempt) when authentication is rejected (535 wrong password)", async () => {
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
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[distribution] SMTP configuration error:"));
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  });

  // I2: the bug this fixes — config/connection-stage errors used to count toward MAX_ATTEMPTS
  // (5), so a ~15-minute SMTP outage (a handful of 2s-apart sendDue calls) would drain the
  // queue to permanently failed. Running the same CONN-error outage across 6+ calls (more than
  // MAX_ATTEMPTS) must leave the message pending with attempts still at 0, never failed.
  it("never fails, and never spends an attempt, across 6+ runs of a connection-stage SMTP outage", async () => {
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stubTransport = {
      sendMail: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2525"), { code: "ECONNREFUSED", command: "CONN" });
      },
    } as unknown as Transporter;
    try {
      let simulatedNow = Date.now();
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

  it("defaults the stop margin to perMessageMs, not a fixed 30s, so a short-but-valid lock for a fast batch still sends", async () => {
    // lockMs (1000ms) is smaller than the fixed 30s margin this loop's check used to use — a
    // fixed 30s default would have tripped it before the very first row, sending nothing. With
    // the margin defaulted off perMessageMs (200ms) instead, there's room for one fast send.
    await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);
    const stubTransport = { sendMail: async () => ({}) } as unknown as Transporter;

    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], batchSize: 1, perMessageMs: 200, lockMs: 1000 });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
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
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[distribution] SMTP configuration error:"));
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
