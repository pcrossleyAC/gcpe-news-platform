import { describe, expect, it } from "vitest";
import { buildSummaryBody, type ListedBounce, type SummaryBodyInput } from "./bounce-summary-body";

const listed = (over: Partial<ListedBounce>): ListedBounce => ({
  address: "a@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics open", subscriber: null, mediaMember: false, ...over,
});
const base: SummaryBodyInput = {
  processed: 9, bounces: 7, ignored: 2,
  hard: [{ email: "hard@example.test", status: "5.1.1", outcome: "recorded (3/15d)", mediaMember: false }],
  soft: { count: 1, rows: [listed({ address: "soft@example.test", mediaMember: true })] },
  unrecorded: { count: 1, rows: [listed({ address: "gone@example.test", status: "5.1.1", message: "550 5.1.1 not found", subject: "Old release", subscriber: "active" })] },
  generatedAt: "October 7, 2026 at 8:00 a.m.", timeZone: "America/Vancouver",
};

describe("buildSummaryBody", () => {
  it("has legacy's parts: totals, hard lines, soft rows with code and message, unrecorded rows with subject and subscriber", () => {
    const { text } = buildSummaryBody(base);
    expect(text).toContain("Bounce reports processed: 9 (7 bounces; 2 other messages, such as auto-replies, not processed).");
    expect(text).toContain("hard@example.test - hard (5.1.1): recorded (3/15d)");
    expect(text).toContain("soft@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open");
    expect(text).toContain("gone@example.test (5.1.1 550 5.1.1 not found) - Old release - NoD subscriber (active)");
    expect(text).not.toContain("<");
  });

  it("labels a counted soft code among the hard lines", () => {
    const { text } = buildSummaryBody({ ...base, hard: [{ email: "c@example.test", status: "4.2.2", outcome: "recorded (1/15d)", mediaMember: false }] });
    expect(text).toContain("c@example.test - soft, counted as hard (4.2.2): recorded (1/15d)");
  });

  it("bolds media-list members only, in HTML only", () => {
    const { html, text } = buildSummaryBody(base);
    expect(html).toContain("<b>soft@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open</b>");
    expect(html).not.toContain("<b>gone@example.test");
    expect(text).not.toContain("<b>");
  });

  it("escapes hostile content from bounce reports", () => {
    const { html } = buildSummaryBody({ ...base, unrecorded: { count: 1, rows: [listed({ message: "<script>alert(1)</script>", subject: "a & b" })] } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("says None. for an empty section and how many rows were left out", () => {
    const { text } = buildSummaryBody({ ...base, hard: [], unrecorded: { count: 2000, rows: [listed({})] } });
    expect(text).toMatch(/Hard bounces \(0\)[^\n]*\nNone\./);
    expect(text).toContain("…and 1999 more not listed here; see the bounce mailbox.");
  });

  it("shows only the not-listed line, without None., when a section's rows were all left out", () => {
    const { text } = buildSummaryBody({ ...base, soft: { count: 3, rows: [] } });
    expect(text).toMatch(/Soft bounces \(3\)[^\n]*\n…and 3 more not listed here; see the bounce mailbox\./);
  });

  it("says not a NoD subscriber for an unknown unrecorded address", () => {
    const { text } = buildSummaryBody({ ...base, unrecorded: { count: 1, rows: [listed({ address: "x@example.test", subscriber: null })] } });
    expect(text).toContain("x@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open - not a NoD subscriber");
  });
});
