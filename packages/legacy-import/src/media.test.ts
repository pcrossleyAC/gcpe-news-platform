import { describe, expect, it } from "vitest";
import { imageTypeFromBytes, justifyFromLegacy } from "./media";

describe("justifyFromLegacy", () => {
  it("maps 0/1 and treats anything else as unset", () => {
    expect([justifyFromLegacy(0), justifyFromLegacy(1), justifyFromLegacy(7), justifyFromLegacy(null)]).toEqual(["left", "right", null, null]);
  });
});

describe("imageTypeFromBytes", () => {
  it("sniffs PNG, JPEG and GIF from magic bytes", () => {
    expect(imageTypeFromBytes(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
    expect(imageTypeFromBytes(Buffer.from("ffd8ffe0", "hex"))).toBe("image/jpeg");
    expect(imageTypeFromBytes(Buffer.from("474946383961", "hex"))).toBe("image/gif");
  });

  it("returns null for unknown or missing bytes", () => {
    expect(imageTypeFromBytes(null)).toBeNull();
    expect(imageTypeFromBytes(Buffer.from("00", "hex"))).toBeNull();
  });
});
