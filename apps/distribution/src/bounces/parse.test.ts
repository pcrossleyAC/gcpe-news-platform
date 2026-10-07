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
});
