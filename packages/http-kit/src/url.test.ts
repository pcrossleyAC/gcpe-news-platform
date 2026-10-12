import { describe, expect, it } from "vitest";
import { isSafeUrl } from "./url";

describe("isSafeUrl", () => {
  it("allows an absolute http or https URL", () => {
    expect(isSafeUrl("https://gov.example/page")).toBe(true);
    expect(isSafeUrl("http://gov.example/page")).toBe(true);
  });

  it("allows a single-slash site-relative path", () => {
    expect(isSafeUrl("/files/a.png")).toBe(true);
    expect(isSafeUrl("/releases/K1/")).toBe(true);
    expect(isSafeUrl("/")).toBe(true);
  });

  it("refuses a relative path when relative: false", () => {
    expect(isSafeUrl("/files/a.png", { relative: false })).toBe(false);
  });

  it("refuses mailto: by default, allows it when asked", () => {
    expect(isSafeUrl("mailto:alex@example.test")).toBe(false);
    expect(isSafeUrl("mailto:alex@example.test", { mailto: true })).toBe(true);
  });

  it("an explicit schemes list overrides the default and mailto", () => {
    expect(isSafeUrl("https://gov.example/x", { schemes: ["https:"] })).toBe(true);
    expect(isSafeUrl("http://gov.example/x", { schemes: ["https:"] })).toBe(false);
    expect(isSafeUrl("mailto:a@example.test", { schemes: ["https:"], mailto: true })).toBe(false);
  });

  it("refuses a protocol-relative //host URL", () => {
    expect(isSafeUrl("//evil.example/x")).toBe(false);
  });

  it("refuses a backslash anywhere — the WHATWG backslash-as-separator bypass", () => {
    expect(isSafeUrl("/\\evil.example/phish")).toBe(false); // leading "/\host" — the reported bypass
    expect(isSafeUrl("\\/evil.example")).toBe(false); // leading "\/host"
    expect(isSafeUrl("/\\\\evil.example")).toBe(false); // "/\\evil.example"
    expect(isSafeUrl("/files/a\\b.png")).toBe(false); // backslash mid-path
  });

  it("refuses javascript:, including case and whitespace tricks", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl(" JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeUrl("\tjavascript:alert(1)\n")).toBe(false);
  });

  it("refuses data: and vbscript:", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("refuses a control character anywhere", () => {
    expect(isSafeUrl("https://gov.example/\u0000x")).toBe(false);
    expect(isSafeUrl("https://gov.example/\u007Fx")).toBe(false);
  });

  it("refuses null, undefined, empty and malformed values", () => {
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl("")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
  });
});
