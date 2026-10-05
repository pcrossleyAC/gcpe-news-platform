import { describe, expect, it } from "vitest";
import { capMessageLength, stripParamsLines } from "./redact";

describe("stripParamsLines", () => {
  it("drops a params: line and trims the rest", () => {
    const message = "Failed query: insert into foo values ($1, $2)\nparams: secret@example.test,abc123";
    expect(stripParamsLines(message)).toBe("Failed query: insert into foo values ($1, $2)");
  });

  it("drops an indented params: line", () => {
    const message = "outer message\n  params: a,b,c\nmore text";
    expect(stripParamsLines(message)).toBe("outer message\nmore text");
  });

  it("leaves a message with no params: line unchanged (aside from trimming)", () => {
    expect(stripParamsLines("  plain message  \n")).toBe("plain message");
  });
});

describe("capMessageLength", () => {
  it("leaves a short message untouched", () => {
    expect(capMessageLength("short")).toBe("short");
  });

  it("truncates a message past the default 2,000-char cap", () => {
    const long = "x".repeat(3_000);
    const capped = capMessageLength(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain("[truncated]");
    expect(capped.startsWith("x".repeat(2_000))).toBe(true);
  });

  it("honours a custom max length", () => {
    expect(capMessageLength("abcdefghij", 5)).toBe("abcde… [truncated]");
  });
});
