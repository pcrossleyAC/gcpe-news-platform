import { describe, expect, it } from "vitest";
import { legacyLinkGuid, legacyTokenHash } from "./legacy-token";
import { hashToken } from "./tokens";

describe("legacyLinkGuid", () => {
  it("decodes the .NET vector: MyIRAFVEd2aImaq7zN3u_w2 → 00112233-4455-6677-8899-aabbccddeeff", () => {
    expect(legacyLinkGuid("MyIRAFVEd2aImaq7zN3u_w2")).toBe("00112233-4455-6677-8899-aabbccddeeff");
  });

  it("accepts a bare GUID in any case and lowercases it", () => {
    expect(legacyLinkGuid("00112233-4455-6677-8899-AABBCCDDEEFF")).toBe("00112233-4455-6677-8899-aabbccddeeff");
    expect(legacyLinkGuid("00112233-4455-6677-8899-aabbccddeeff")).toBe("00112233-4455-6677-8899-aabbccddeeff");
  });

  it.each(["", "abc", "MyIRAFVEd2aImaq7zN3u_w1", "MyIRAFVEd2aImaq7zN3u_w", "!!!!!!!!!!!!!!!!!!!!!!2", "x".repeat(5000), "MyIRAFVEd2aImaq7zN3u_x2", "00112233-4455-6677-8899-aabbccddeeffa"])(
    "returns null for %j without throwing",
    (t) => {
      expect(legacyLinkGuid(t)).toBeNull();
    },
  );

  it("never throws on non-string input", () => {
    expect(legacyLinkGuid(undefined as unknown as string)).toBeNull();
  });

  it("hashes with a legacy: prefix, apart from ordinary token hashes", () => {
    expect(legacyTokenHash("g")).toBe(hashToken("legacy:g"));
  });
});
