import { describe, expect, it } from "vitest";
import { messageRequestSchema } from "./messages";
import { sampleMessageRequest } from "../test/helpers";

describe("messageRequestSchema", () => {
  it("rejects a subject containing CR/LF (header injection via the subject line)", () => {
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, subject: "Hi\r\nBcc: evil@x.com" })).toThrow();
  });

  it("rejects a header value containing a line break", () => {
    expect(() =>
      messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "X-Test": "line1\nline2" } }),
    ).toThrow();
  });

  it("rejects disallowed header names, case-insensitively", () => {
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, headers: { Bcc: "evil@x.com" } })).toThrow();
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, headers: { bcc: "evil@x.com" } })).toThrow();
  });

  it("accepts list-unsubscribe case-insensitively and stores it under its canonical casing", () => {
    const parsed = messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "list-unsubscribe": "<mailto:x@y.com>" } });
    expect(parsed.headers).toEqual({ "List-Unsubscribe": "<mailto:x@y.com>" });
  });

  it("accepts an X-* extension header", () => {
    const parsed = messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "X-Campaign": "autumn-2026" } });
    expect(parsed.headers).toEqual({ "X-Campaign": "autumn-2026" });
  });

  it("rejects a caller-supplied Reply-To header — Distribution owns it, via the top-level replyTo field instead", () => {
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "Reply-To": "spoofed@evil.com" } })).toThrow();
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "reply-to": "spoofed@evil.com" } })).toThrow();
  });

  it("rejects a caller-supplied Message-ID header — Distribution owns it entirely", () => {
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, headers: { "Message-ID": "<fake@evil.com>" } })).toThrow();
  });

  it("accepts a valid top-level replyTo", () => {
    const parsed = messageRequestSchema.parse({ ...sampleMessageRequest, replyTo: "reply@example.com" });
    expect(parsed.replyTo).toBe("reply@example.com");
  });

  it("rejects a replyTo that isn't an email address", () => {
    expect(() => messageRequestSchema.parse({ ...sampleMessageRequest, replyTo: "not-an-address" })).toThrow();
  });

  it("omits replyTo when the caller doesn't set one", () => {
    const parsed = messageRequestSchema.parse(sampleMessageRequest);
    expect(parsed.replyTo).toBeUndefined();
  });
});
