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

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });

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
      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: ["qa@example.com"], now: () => new Date(Date.now() + 1000) });

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
      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: ["qa@example.com"], now: () => new Date(Date.now() + 1000) });

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
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });

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
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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
      const second = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
      expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });

      const [row] = await tdb.db.select().from(messages);
      expect(row!.status).toBe("failed");
      expect(row!.attempts).toBe(1);
    } finally {
      await transport.close();
      await sink.close();
    }
  });

  // R1: nodemailer's transport.verify() only attempts AUTH when the transport itself is
  // *configured* with credentials (see smtp-transport's verify(): no configured auth -> no
  // login attempt -> finalize() succeeds regardless of what the server would actually demand
  // at MAIL FROM). A transport with no `auth` block at all therefore can't be told apart from
  // a poison message by verify() — this specific misconfiguration (missing credentials) is
  // genuinely indistinguishable from "this message is bad" without literally sending mail,
  // which is exactly what already happened. So it's treated as the message's fault: every
  // recipient in the batch is attempted (the run does NOT stop), each spends an attempt, and
  // each is logged as a transient error rather than a stopped-run deferral.
  it("treats 'auth required but none configured' (530) as a transient per-message error, not a stopped-run deferral, since verify() can't exercise a missing-credentials gap", async () => {
    const sink = await startSmtpSink({ requireAuth: true });
    // No `auth` configured: the client never sends AUTH, so the server's 530 fires at MAIL FROM
    // — and transport.verify() (which only attempts AUTH when configured) reports healthy.
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(
        tdb.db,
        "app",
        { ...sampleMessageRequest, recipients: [{ email: "a@example.com", substitutions: {} }, { email: "b@example.com", substitutions: {} }, { email: "c@example.com", substitutions: {} }] },
        internalDomains,
      );

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
      expect(result).toEqual({ sent: 0, retried: 3, failed: 0 });

      const rows = await tdb.db.select().from(messages);
      expect(rows.every((r) => r.status === "pending" && r.attempts === 1 && r.deferrals === 0)).toBe(true);

      const transientCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("transient error:"));
      expect(transientCalls).toHaveLength(3);
      const serverDownCalls = errorSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[distribution] SMTP server unavailable/misconfigured:"));
      expect(serverDownCalls).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await sink.close();
    }
  });

  it("retries (does not fail, does not spend an attempt) when authentication is rejected (535 wrong password) — verify() fails the same way, so this stays a server/config problem", async () => {
    const sink = await startSmtpSink({ requireAuth: true });
    const transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true, auth: { user: "svc", pass: "wrong" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createBatch(tdb.db, "app", { ...sampleMessageRequest, recipients: [{ email: "x@example.com", substitutions: {} }] }, internalDomains);

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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
      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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

    let simulatedNow = Date.now();
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
      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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
        now: () => new Date(Date.now() + 1000),
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

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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

      await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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
        sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 50 }),
        sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 50 }),
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
      const firstRun = sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 6, lockMs: 300, lockMarginMs: 100 });
      await sleep(320); // past the first run's lock, while it may still be mid-batch
      const secondRun = sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 6 }); // generous default lock
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

      const result = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), stopRequested: () => sink.messages.length >= 1 });

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
    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 6, lockMs: 120_000 });

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
      redirectTo: [], now: () => new Date(Date.now() + 1000),
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
      const second = await sendDue({ db: tdb.db, transport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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

    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000), batchSize: 1, perMessageMs: 200, lockMs: 1000 });
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

      const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
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

    const result = await sendDue({ db: tdb.db, transport: stubTransport, from: "news@example.com", redirectTo: [], now: () => new Date(Date.now() + 1000) });
    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });

    const [row] = await tdb.db.select().from(messages);
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
  });
});
