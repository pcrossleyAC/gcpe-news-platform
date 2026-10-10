import { describe, expect, it } from "vitest";
import { cleanDetails, cleanTitle } from "./clean";

describe("legacy's text clean-up (C145: on create as on update)", () => {
  it("a title: trimmed, line breaks as spaces, special characters replaced", () => {
    expect(cleanTitle("  “Sample”\r\ntitle — one… ")).toBe('"Sample"  title - one...');
  });
  it("details: trimmed and special characters replaced, line breaks kept", () => {
    expect(cleanDetails(" It’s\nhere now ")).toBe("It's\nhere now");
  });
  it("a non-breaking space becomes a plain space", () => {
    expect(cleanDetails("a b")).toBe("a b");
  });
});
