import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBounce } from "./parse";

const fixturesDir = fileURLToPath(new URL("../../test/fixtures/bounces", import.meta.url));
const fixture = (name: string): string => readFileSync(`${fixturesDir}/${name}`, "utf8");

describe("parseBounce", () => {
  it("parses an Exchange NDR (message/delivery-status + text/rfc822-headers) as a hard bounce", async () => {
    const result = await parseBounce(fixture("exchange-ndr.eml"));
    expect(result).toEqual({
      kind: "bounce",
      recipient: "baduser@example.test",
      status: "5.1.1",
      hard: true,
      originalMessageId: "<exchange-row-1@dist.example.test>",
      method: "rfc3464",
      diagnostic: "550 5.1.1 RESOLVER.ADR.RecipNotFound; not found",
      originalSubject: "Weekend clinics open across B.C.",
    });
  });

  it("parses a Gmail-style DSN (message/rfc822) as a hard bounce", async () => {
    const result = await parseBounce(fixture("gmail-dsn.eml"));
    expect(result).toEqual({
      kind: "bounce",
      recipient: "gone@example.test",
      status: "5.1.1",
      hard: true,
      originalMessageId: "<gmail-row-2@dist.example.test>",
      method: "rfc3464",
      diagnostic: "550-5.1.1 The email account that you tried to reach does not exist.",
      originalSubject: "Weekend clinics open across B.C.",
    });
  });

  it("parses a 4.x.x delay notice as a soft bounce", async () => {
    const result = await parseBounce(fixture("delay-4xx.eml"));
    expect(result).toEqual({
      kind: "bounce",
      recipient: "slow@example.test",
      status: "4.4.7",
      hard: false,
      originalMessageId: "<delay-row-3@dist.example.test>",
      method: "rfc3464",
      diagnostic: "421 4.4.7 Delivery temporarily delayed",
      originalSubject: "Weekend clinics open across B.C.",
    });
  });

  it("falls back to the legacy heuristic for a plain-text Undeliverable: with no Message-ID", async () => {
    const result = await parseBounce(fixture("legacy-undeliverable.eml"));
    expect(result).toEqual({
      kind: "bounce",
      recipient: "legacy@example.test",
      status: "5.1.1",
      hard: true,
      originalMessageId: null,
      method: "heuristic",
      diagnostic: "relay.example.test #5.1.1 smtp;550 5.1.1 legacy@example.test User unknown",
      originalSubject: "Weekend clinics open across B.C.",
    });
  });

  it("ignores an auto-reply", async () => {
    const result = await parseBounce(fixture("auto-reply.eml"));
    expect(result.kind).toBe("ignored");
  });

  it("never throws on a malformed message, and reports it ignored", async () => {
    const result = await parseBounce(fixture("malformed.eml"));
    expect(result.kind).toBe("ignored");
  });

  it("heuristic: picks the first email address in the body and the first error code", async () => {
    const result = await parseBounce(fixture("legacy-undeliverable.eml"));
    if (result.kind !== "bounce") throw new Error("expected a bounce");
    // The body contains "legacy@example.test" before any other address-looking text, and the
    // enhanced code "5.1.1" appears before the bare "550" the legacy regex also matches.
    expect(result.recipient).toBe("legacy@example.test");
    expect(result.status).toBe("5.1.1");
  });

  // Fix round 1, I1: a folded Final-Recipient/Status (RFC 5322 continuation lines — a header
  // value wrapped across a line starting with whitespace) must still parse as a bounce, not
  // silently become "ignored".
  it("unfolds a folded Final-Recipient and Status in an RFC 3464 DSN", async () => {
    const result = await parseBounce(fixture("folded-fields.eml"));
    expect(result).toEqual({
      kind: "bounce",
      recipient: "folded@example.test",
      status: "5.1.1",
      hard: true,
      originalMessageId: "<folded-row@dist.example.test>",
      method: "rfc3464",
      diagnostic: "550 5.1.1 User unknown",
      originalSubject: "Weekend clinics open across B.C.",
    });
  });

  it("caps a huge Diagnostic-Code at 200 characters and collapses whitespace", async () => {
    const raw = fixture("gmail-dsn.eml").replace(
      "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
      `Diagnostic-Code: smtp; 550 5.1.1   ${"<script>x</script> ".repeat(60_000)}`,
    );
    const result = await parseBounce(raw);
    if (result.kind !== "bounce") throw new Error("expected a bounce");
    expect(result.diagnostic!.length).toBe(200);
    expect(result.diagnostic!.endsWith("…")).toBe(true);
    expect(result.diagnostic).not.toMatch(/\s{2}/);
  });

  it("decodes an RFC 2047 encoded original Subject", async () => {
    const raw = fixture("gmail-dsn.eml").replace(
      /\r?\nSubject: Weekend clinics open across B\.C\./,
      "\r\nSubject: =?UTF-8?Q?Caf=C3=A9_hours_extended?=",
    );
    const result = await parseBounce(raw);
    if (result.kind !== "bounce") throw new Error("expected a bounce");
    expect(result.originalSubject).toBe("Café hours extended");
  });

  it("falls back to the bounce's own subject minus Undeliverable: when the original has none", async () => {
    const raw = fixture("exchange-ndr.eml").replace(/\r?\nSubject: Weekend clinics open across B\.C\.(\r?\n)(?=[\s\S]*--)/, "$1");
    const result = await parseBounce(raw);
    if (result.kind !== "bounce") throw new Error("expected a bounce");
    expect(result.originalSubject).toBe("Weekend clinics open across B.C.");
  });
});

// Fix round 1, C1: the first-email-in-body scan (heuristic recipient extraction, and the DSN
// address-field extraction) must be bounded and linear in its input, not a backtracking regex
// over attacker-controlled, unbounded content — the reviewer measured ~514s on a 1MB body of
// "a" with the un-fixed `[\w.-]+@[\w.-]+` regex.
describe("parseBounce performance", () => {
  const PERF_BUDGET_MS = 1000;

  function undeliverableWithBody(body: string): string {
    return (
      "From: postmaster@mail.example.test\n" +
      "To: distribution@example.test\n" +
      "Subject: Undeliverable: Weekend clinics open across B.C.\n" +
      'Content-Type: text/plain; charset="utf-8"\n' +
      "MIME-Version: 1.0\n\n" +
      body +
      "\n"
    );
  }

  it("parses a 1 MB body with no '@' in well under 1s", async () => {
    const raw = undeliverableWithBody("a".repeat(1_000_000));
    const start = Date.now();
    const result = await parseBounce(raw);
    expect(Date.now() - start).toBeLessThan(PERF_BUDGET_MS);
    expect(result.kind).toBe("ignored"); // no '@' at all, so no recipient — and no error code
  });

  it("parses a 1 MB body of 'a@a@a…' in well under 1s", async () => {
    const raw = undeliverableWithBody("a@".repeat(500_000));
    const start = Date.now();
    const result = await parseBounce(raw);
    expect(Date.now() - start).toBeLessThan(PERF_BUDGET_MS);
    expect(result.kind).toBe("ignored"); // an address-looking span is found, but no error code
  });

  it("stays fast on an RFC 3464 DSN whose Final-Recipient field is padded with 1MB of non-address text", async () => {
    const raw =
      "From: postmaster@mail.example.test\n" +
      "To: distribution@example.test\n" +
      "Subject: Delivery Status Notification (Failure)\n" +
      'Content-Type: multipart/report; report-type=delivery-status;\n\tboundary="PERF-BOUNDARY"\n' +
      "MIME-Version: 1.0\n\n" +
      "--PERF-BOUNDARY\n" +
      'Content-Type: text/plain; charset="utf-8"\n\n' +
      "Delivery failed.\n\n" +
      "--PERF-BOUNDARY\n" +
      "Content-Type: message/delivery-status\n\n" +
      "Reporting-MTA: dns;mail.example.test\n\n" +
      `Final-Recipient: rfc822;${"x".repeat(1_000_000)}\n` +
      "Action: failed\n" +
      "Status: 5.1.1\n\n" +
      "--PERF-BOUNDARY--\n";
    const start = Date.now();
    const result = await parseBounce(raw);
    expect(Date.now() - start).toBeLessThan(PERF_BUDGET_MS);
    expect(result.kind).toBe("ignored"); // padded field has no address at all
  });
});
